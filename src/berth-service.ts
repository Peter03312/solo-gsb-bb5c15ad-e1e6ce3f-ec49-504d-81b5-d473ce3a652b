import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors';
import { DischargeSimulation } from './discharge';
import {
  evaluatePort,
  parseTimeWindow,
  sameAdjustmentContent,
  sameBookingContent,
} from './berthing';

/* ---------- DTO ---------- */

export interface CreateBerthBookingInput {
  /** 已留档卸货审查 ID */
  reviewId: string;
  /** 审查内的卸港（必须是实际有卸箱且无受阻箱的港） */
  dischargePort: string;
  /** 泊位 */
  berth: string;
  /** 带时区的起始时刻（ISO 8601） */
  startAt: string;
  /** 带时区的结束时刻（ISO 8601，须晚于起始） */
  endAt: string;
  /** 客户端提交号：同一审查内唯一（同号同内容重试幂等） */
  submissionNo: string;
}

export interface RescheduleBerthBookingInput {
  /** 原预订 ID（路径参数；仅仍有效的预订可改期） */
  bookingId: string;
  /** 新泊位 */
  berth: string;
  /** 带时区的新起始时刻（ISO 8601） */
  startAt: string;
  /** 带时区的新结束时刻（ISO 8601，须晚于起始） */
  endAt: string;
  /** 客户端调整号：同一原预订内唯一（同号同内容重试幂等） */
  adjustmentNo: string;
}

interface ReviewRefRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  request_jsonb: { ports: string[] };
  result_jsonb: DischargeSimulation;
}

interface BookingRow {
  id: string;
  review_id: string;
  voyage_id: string;
  discharge_port: string;
  berth: string;
  start_at: Date;
  end_at: Date;
  /** 提交号（仅原始预订有；改期产生的新记录为 NULL） */
  submission_no: string | null;
  /** 调整号（仅改期产生的新记录有） */
  adjustment_no: string | null;
  /** 本记录由哪条预订改期而来（原始预订为 NULL） */
  rescheduled_from: string | null;
  /** 本记录被哪条新记录改期替换（未被替换为 NULL） */
  superseded_by: string | null;
  status: 'booked' | 'cancelled';
  manifest_rev: number;
  port_box_count: number;
  created_at: Date;
  cancelled_at: Date | null;
}

/* ---------- 序列化 ---------- */

function bookingToJson(row: BookingRow) {
  return {
    bookingId: row.id,
    reviewId: row.review_id,
    voyageId: row.voyage_id,
    dischargePort: row.discharge_port,
    berth: row.berth,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    submissionNo: row.submission_no,
    adjustmentNo: row.adjustment_no,
    rescheduledFrom: row.rescheduled_from,
    supersededBy: row.superseded_by,
    status: row.status,
    open: row.status === 'booked',
    frozenManifestRevision: row.manifest_rev,
    dischargedBoxCount: row.port_box_count,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
  };
}

type BookingJson = ReturnType<typeof bookingToJson>;

/* ---------- PG 唯一/排他冲突映射 ---------- */

const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';

interface ConflictTarget {
  kind: 'review_port_active' | 'port_berth_overlap' | 'submission_no' | 'adjustment_no';
}

/**
 * 根据排他/唯一约束名判断冲突类型（约束名见 schema.sql）。
 * 无法识别则返回 null，交由上层按内部错误处理。
 */
function classifyPgConstraint(constraintName: string | undefined): ConflictTarget['kind'] | null {
  switch (constraintName) {
    case 'uq_berth_booking_active_review_port':
      return 'review_port_active';
    case 'excl_berth_booking_port_berth_window':
      return 'port_berth_overlap';
    case 'berth_bookings_review_id_submission_no_key':
      return 'submission_no';
    case 'uq_berth_booking_adjustment':
      return 'adjustment_no';
    default:
      return null;
  }
}

/* ---------- 读取辅助 ---------- */

const BOOKING_COLUMNS = `id, review_id, voyage_id, discharge_port, berth, start_at, end_at,
  submission_no, adjustment_no, rescheduled_from, superseded_by,
  status, manifest_rev, port_box_count, created_at, cancelled_at`;

async function loadReviewForUpdate(
  client: PoolClient,
  reviewId: string,
): Promise<ReviewRefRow | null> {
  const res = await client.query(
    `SELECT id, voyage_id, manifest_rev, request_jsonb, result_jsonb
     FROM discharge_reviews WHERE id=$1 FOR UPDATE`,
    [reviewId],
  );
  return (res.rows[0] as ReviewRefRow | undefined) ?? null;
}

async function loadBookingForUpdate(
  client: PoolClient,
  bookingId: string,
): Promise<BookingRow | null> {
  const res = await client.query(
    `SELECT ${BOOKING_COLUMNS}
     FROM berth_bookings WHERE id=$1 FOR UPDATE`,
    [bookingId],
  );
  return (res.rows[0] as BookingRow | undefined) ?? null;
}

async function loadActiveBooking(client: PoolClient, reviewId: string, dischargePort: string) {
  const res = await client.query(
    `SELECT ${BOOKING_COLUMNS}
     FROM berth_bookings
     WHERE review_id=$1 AND discharge_port=$2 AND status='booked'`,
    [reviewId, dischargePort],
  );
  return (res.rows[0] as BookingRow | undefined) ?? null;
}

/** 在事务外查询与待插入窗口重叠的同港同泊位有效预订（排他冲突后的 409 明细） */
async function queryOverlapping(
  pool: Pool,
  window: { dischargePort: string; berth: string; start: Date; end: Date },
  excludeBookingId?: string,
): Promise<BookingJson | null> {
  const res = await pool.query(
    `SELECT ${BOOKING_COLUMNS}
     FROM berth_bookings
     WHERE status='booked' AND discharge_port=$1 AND berth=$2
       AND tstzrange(start_at, end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
       AND ($5::uuid IS NULL OR id <> $5::uuid)
     ORDER BY start_at LIMIT 1`,
    [
      window.dischargePort,
      window.berth,
      window.start.toISOString(),
      window.end.toISOString(),
      excludeBookingId ?? null,
    ],
  );
  const row = res.rows[0] as BookingRow | undefined;
  return row ? bookingToJson(row) : null;
}

/** 在事务外查询某审查某卸港的有效预订（唯一冲突后的 409 明细） */
async function queryActivePort(
  pool: Pool,
  reviewId: string,
  dischargePort: string,
): Promise<BookingJson | null> {
  const res = await pool.query(
    `SELECT ${BOOKING_COLUMNS} FROM berth_bookings
     WHERE review_id=$1 AND discharge_port=$2 AND status='booked'`,
    [reviewId, dischargePort],
  );
  const row = res.rows[0] as BookingRow | undefined;
  return row ? bookingToJson(row) : null;
}

/** 把底层 PG 唯一/排他冲突转换为业务 409（调用前事务必须已回滚，以便事务外补充明细） */
async function mapInsertConflict(
  err: unknown,
  pool: Pool,
  input: CreateBerthBookingInput,
): Promise<HttpError | null> {
  const code = (err as { code?: string }).code;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const constraint = (err as any)?.constraint as string | undefined;
  const kind = classifyPgConstraint(constraint);
  if (code === PG_EXCLUSION_VIOLATION && kind === 'port_berth_overlap') {
    return HttpError.conflict(
      'berth_window_overlap',
      `卸港 ${input.dischargePort} 泊位 ${input.berth} 在该时段已有有效靠泊窗口，同港同泊位窗口不得重叠（首尾相接允许），并发预订仅一方成功`,
      {
        conflicting: await queryOverlapping(pool, {
          dischargePort: input.dischargePort,
          berth: input.berth,
          start: new Date(input.startAt),
          end: new Date(input.endAt),
        }),
      },
    );
  }
  if (code === PG_UNIQUE_VIOLATION && kind === 'review_port_active') {
    return HttpError.conflict(
      'booking_exists_for_port',
      `审查 ${input.reviewId} 对卸港 ${input.dischargePort} 已存在有效预订，同一审查同一卸港至多一个有效预订`,
      { existingBooking: await queryActivePort(pool, input.reviewId, input.dischargePort) },
    );
  }
  if (code === PG_UNIQUE_VIOLATION && kind === 'submission_no') {
    return HttpError.conflict(
      'booking_submission_conflict',
      `提交号 ${input.submissionNo} 已在该审查中被使用`,
      { reviewId: input.reviewId, submissionNo: input.submissionNo },
    );
  }
  return null;
}

/**
 * 改期插入新记录时的底层冲突映射（调用前事务必须已回滚——回滚即恢复原预订）。
 * 新窗口若与其他有效预订重叠 -> 409 berth_window_overlap（明细中排除原预订自身：
 * 原预订已在同事务内释放，与新窗口重叠不算冲突）。
 */
async function mapRescheduleConflict(
  err: unknown,
  pool: Pool,
  input: RescheduleBerthBookingInput,
  original: BookingRow,
): Promise<HttpError | null> {
  const code = (err as { code?: string }).code;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const constraint = (err as any)?.constraint as string | undefined;
  const kind = classifyPgConstraint(constraint);
  if (code === PG_EXCLUSION_VIOLATION && kind === 'port_berth_overlap') {
    return HttpError.conflict(
      'berth_window_overlap',
      `卸港 ${original.discharge_port} 泊位 ${input.berth} 在新时段已被其他有效靠泊窗口占用，同港同泊位窗口不得重叠（首尾相接允许）；原预订 ${input.bookingId} 保持不变`,
      {
        conflicting: await queryOverlapping(
          pool,
          {
            dischargePort: original.discharge_port,
            berth: input.berth,
            start: new Date(input.startAt),
            end: new Date(input.endAt),
          },
          input.bookingId,
        ),
      },
    );
  }
  if (code === PG_UNIQUE_VIOLATION && kind === 'review_port_active') {
    return HttpError.conflict(
      'booking_exists_for_port',
      `审查 ${original.review_id} 对卸港 ${original.discharge_port} 已存在有效预订，同一审查同一卸港至多一个有效预订；原预订 ${input.bookingId} 保持不变`,
      { existingBooking: await queryActivePort(pool, original.review_id, original.discharge_port) },
    );
  }
  if (code === PG_UNIQUE_VIOLATION && kind === 'adjustment_no') {
    // 兜底：同一原预订的并发改期已被原预订行锁串行化，正常不会走到
    return HttpError.conflict(
      'booking_adjustment_conflict',
      `调整号 ${input.adjustmentNo} 已用于对预订 ${input.bookingId} 的改期`,
      { bookingId: input.bookingId, adjustmentNo: input.adjustmentNo },
    );
  }
  return null;
}

/* ---------- 服务 ---------- */

export class BerthBookingService {
  constructor(private readonly pool: Pool) {}

  /**
   * 依据已留档卸货审查预订靠泊窗口。
   *
   * 事务内先锁审查行（串行化同一审查的并发预订），随后：
   *  1. 审查必须存在（未知审查 -> 404 discharge_review_not_found）；
   *  2. 提交号在该审查内唯一：同号同内容 -> 200 replay:true 返回原预订【当前状态】；
   *     同号改内容 -> 409 booking_submission_conflict；
   *  3. 卸港必须在审查港序中（未知卸港 -> 400 unknown_discharge_port_for_review），
   *     且该港有实际卸箱、无受阻箱（否则 422 port_not_dischargeable）；
   *  4. 起止时刻须为带时区时刻且起点严格早于终点（否则 400 invalid_time_window）；
   *  5. 同审查同卸港至多一个有效预订（409 booking_exists_for_port）；
   *  6. 同港同泊位有效窗口不得重叠（半开区间，首尾相接可用；跨审查/跨航次同样互斥；
   *     409 berth_window_overlap）。由部分 gist 排他约束最终把关，并发竞争只成功一方。
   *
   * 受理时冻结清单修订号与该港实际卸箱数；审查/清单后续调整或签发新清单不回写本预订。
   */
  async createBooking(
    input: CreateBerthBookingInput,
  ): Promise<{ replay: boolean; booking: BookingJson }> {
    const client = await this.pool.connect();
    let releasedEarly = false;
    try {
      await client.query('BEGIN');

      // 锁审查行：未知审查即 404；同时串行化基于同一审查的并发提交
      const review = await loadReviewForUpdate(client, input.reviewId);
      if (!review) {
        throw HttpError.notFound(
          'discharge_review_not_found',
          `卸货审查 ${input.reviewId} 不存在，无法据此预订靠泊窗口`,
        );
      }

      // 提交号幂等 / 冲突判定（优先级最高；即使原窗口已被取消，同号重试也回放原记录）
      const existingRes = await client.query(
        `SELECT ${BOOKING_COLUMNS}
         FROM berth_bookings WHERE review_id=$1 AND submission_no=$2`,
        [input.reviewId, input.submissionNo],
      );
      const existing = existingRes.rows[0] as BookingRow | undefined;
      if (existing) {
        const same = sameBookingContent(
          {
            dischargePort: existing.discharge_port,
            berth: existing.berth,
            startMs: existing.start_at.getTime(),
            endMs: existing.end_at.getTime(),
          },
          {
            dischargePort: input.dischargePort,
            berth: input.berth,
            startMs: Date.parse(input.startAt),
            endMs: Date.parse(input.endAt),
          },
        );
        if (!same) {
          throw HttpError.conflict(
            'booking_submission_conflict',
            `提交号 ${input.submissionNo} 已在该审查中用于不同的预订内容，提交号不可复用；重新预订请改用新提交号`,
            {
              reviewId: input.reviewId,
              submissionNo: input.submissionNo,
              stored: bookingToJson(existing),
              incoming: {
                dischargePort: input.dischargePort,
                berth: input.berth,
                startAt: input.startAt,
                endAt: input.endAt,
              },
            },
          );
        }
        await client.query('COMMIT');
        // 同号同内容：返回原预订的当前状态（可能已被取消）
        return { replay: true, booking: bookingToJson(existing) };
      }

      // 卸港必须在审查港序中
      if (!review.request_jsonb.ports.includes(input.dischargePort)) {
        throw HttpError.badRequest(
          'unknown_discharge_port_for_review',
          `卸港 ${input.dischargePort} 不在卸货审查 ${input.reviewId} 的港序列表中`,
          {
            reviewId: input.reviewId,
            dischargePort: input.dischargePort,
            reviewPorts: review.request_jsonb.ports,
          },
        );
      }

      // 时刻：必须带时区、可解析、起点严格早于终点
      const window = parseTimeWindow({ startAt: input.startAt, endAt: input.endAt });
      if (window.issues.length > 0) {
        throw HttpError.badRequest('invalid_time_window', '靠泊窗口时刻非法，已拒绝', {
          issueCount: window.issues.length,
          issues: window.issues,
        });
      }

      // 受理条件：该港有实际卸箱且无受阻箱（读取已冻结的模拟结果）
      const acceptance = evaluatePort(review.result_jsonb, input.dischargePort);
      if (!acceptance.acceptable) {
        throw new HttpError(
          422,
          'port_not_dischargeable',
          `卸港 ${input.dischargePort} 在该审查中不满足受理条件（实际卸箱 ${acceptance.dischargedCount}、受阻 ${acceptance.blockedCount}）：仅受理有实际卸箱且无受阻箱的港`,
          {
            reviewId: input.reviewId,
            dischargePort: input.dischargePort,
            dischargedBoxCount: acceptance.dischargedCount,
            blockedBoxCount: acceptance.blockedCount,
          },
        );
      }

      // 同审查同卸港至多一个有效预订（给出更明确的既有预订；唯一索引兜底并发）
      const activeSamePort = await loadActiveBooking(client, input.reviewId, input.dischargePort);
      if (activeSamePort) {
        throw HttpError.conflict(
          'booking_exists_for_port',
          `审查 ${input.reviewId} 对卸港 ${input.dischargePort} 已存在有效预订，同一审查同一卸港至多一个有效预订；可取消后用新提交号重新预订，或对既有预订发起改期（reschedule）`,
          { existingBooking: bookingToJson(activeSamePort) },
        );
      }

      // 插入：冻结清单修订号与该港实际卸箱数；窗口互斥由部分 gist 排他约束最终保证
      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO berth_bookings
             (review_id, voyage_id, discharge_port, berth, start_at, end_at,
              submission_no, manifest_rev, port_box_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${BOOKING_COLUMNS}`,
          [
            input.reviewId,
            review.voyage_id,
            input.dischargePort,
            input.berth,
            window.start!.toISOString(),
            window.end!.toISOString(),
            input.submissionNo,
            review.manifest_rev,
            acceptance.dischargedCount,
          ],
        );
      } catch (err) {
        // 语句报错后当前事务已中止：先回滚释放审查行锁并归还连接，
        // 再在事务外补充冲突明细（不能在已中止事务里继续查询）。
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        releasedEarly = true;
        const mapped = await mapInsertConflict(err, this.pool, input);
        if (mapped) throw mapped;
        throw err;
      }

      const row = inserted.rows[0] as BookingRow;
      await client.query('COMMIT');
      return { replay: false, booking: bookingToJson(row) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      if (!releasedEarly) client.release();
    }
  }

  /**
   * 按预订 ID 取消：记录保留、状态置 cancelled、cancelled_at 落库，
   * 因部分索引/排他约束只含 booked，占用立即释放。重复取消幂等返回已取消状态。
   */
  async cancelBooking(bookingId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const booking = await loadBookingForUpdate(client, bookingId);
      if (!booking) {
        throw HttpError.notFound('berth_booking_not_found', `靠泊预订 ${bookingId} 不存在`);
      }

      if (booking.status === 'cancelled') {
        await client.query('COMMIT');
        return { cancelled: true, replay: true, booking: bookingToJson(booking) };
      }

      const updated = await client.query(
        `UPDATE berth_bookings SET status='cancelled', cancelled_at=now()
         WHERE id=$1
         RETURNING ${BOOKING_COLUMNS}`,
        [bookingId],
      );
      const row = updated.rows[0] as BookingRow;
      await client.query('COMMIT');
      return { cancelled: true, replay: false, booking: bookingToJson(row) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 改期已生效的靠泊预订：提交原预订 ID、新泊位、带时区起止时刻与调整号。
   *
   * 事务内先锁原预订行（串行化同一预订的并发改期/取消），随后：
   *  1. 原预订必须存在（未知预订 -> 404 berth_booking_not_found）；
   *  2. 调整号在同一原预订内唯一：同号同内容 -> 200 replay:true 返回【新记录当前状态】
   *     （新记录可能已被取消或再次改期）；同号改内容 -> 409 booking_adjustment_conflict；
   *  3. 仅在原预订仍有效（booked）时受理，已取消（含已被改期替换）-> 409 booking_not_active；
   *  4. 起止时刻须为带时区时刻且起点严格早于终点（否则 400 invalid_time_window）；
   *  5. 原子换窗：同事务内先把旧记录置 cancelled 并以 superseded_by 关联新记录（释放旧窗口，
   *     故新窗口允许与原窗口自身重叠/相接），再插入占用新窗口的新记录——新记录继承原审查、
   *     卸港及冻结的清单修订号与实际卸箱数，submission_no 为空、记录 adjustment_no 与
   *     rescheduled_from；新窗口沿用同审查同港唯一、同港同泊位半开区间不重叠规则
   *     （排他/唯一约束兜底，冲突 -> 409 berth_window_overlap / booking_exists_for_port）。
   *
   * 任一校验失败或插入冲突都整体回滚：无效时刻、已取消原预订、调整号冲突或新窗口被占用时，
   * 原预订保持不变。时刻按绝对瞬间比较（不同时区写法指向同一时刻即相同）。
   */
  async rescheduleBooking(
    input: RescheduleBerthBookingInput,
  ): Promise<{ replay: boolean; booking: BookingJson; superseded: BookingJson }> {
    const client = await this.pool.connect();
    let releasedEarly = false;
    try {
      await client.query('BEGIN');

      // 锁原预订行：未知预订即 404；同时串行化同一预订的并发改期/取消
      const original = await loadBookingForUpdate(client, input.bookingId);
      if (!original) {
        throw HttpError.notFound(
          'berth_booking_not_found',
          `靠泊预订 ${input.bookingId} 不存在，无法改期`,
        );
      }

      // 调整号幂等 / 冲突判定（优先级最高：即使原预订已因此次调整而取消，同号重试也回放新记录当前状态）
      const childRes = await client.query(
        `SELECT ${BOOKING_COLUMNS}
         FROM berth_bookings WHERE rescheduled_from=$1 AND adjustment_no=$2
         FOR UPDATE`,
        [input.bookingId, input.adjustmentNo],
      );
      const child = childRes.rows[0] as BookingRow | undefined;
      if (child) {
        const same = sameAdjustmentContent(
          { berth: child.berth, startMs: child.start_at.getTime(), endMs: child.end_at.getTime() },
          { berth: input.berth, startMs: Date.parse(input.startAt), endMs: Date.parse(input.endAt) },
        );
        if (!same) {
          throw HttpError.conflict(
            'booking_adjustment_conflict',
            `调整号 ${input.adjustmentNo} 已用于对预订 ${input.bookingId} 的不同改期内容，调整号不可复用；再次改期请改用新调整号`,
            {
              bookingId: input.bookingId,
              adjustmentNo: input.adjustmentNo,
              stored: bookingToJson(child),
              incoming: { berth: input.berth, startAt: input.startAt, endAt: input.endAt },
            },
          );
        }
        await client.query('COMMIT');
        // 同号同内容：返回新记录的当前状态（可能已被取消或被再次改期替换）
        return { replay: true, booking: bookingToJson(child), superseded: bookingToJson(original) };
      }

      // 仅在原预订仍有效时受理（已取消/已被改期替换的预订不可再改期）
      if (original.status !== 'booked') {
        throw HttpError.conflict(
          'booking_not_active',
          `靠泊预订 ${input.bookingId} 已不是有效状态（已取消或已被改期替换），仅仍有效的预订可以改期；原预订保持不变`,
          { booking: bookingToJson(original) },
        );
      }

      // 时刻：必须带时区、可解析、起点严格早于终点
      const window = parseTimeWindow({ startAt: input.startAt, endAt: input.endAt });
      if (window.issues.length > 0) {
        throw HttpError.badRequest(
          'invalid_time_window',
          '靠泊窗口时刻非法，已拒绝；原预订保持不变',
          {
            issueCount: window.issues.length,
            issues: window.issues,
          },
        );
      }

      // 原子换窗：先释放旧窗口（置取消并关联新记录），再占用新窗口。
      // 新记录继承原审查、卸港与冻结的清单修订号/实际卸箱数；提交号为空（提交号幂等键只属于原始预订）。
      const newId = randomUUID();
      const supersededRes = await client.query(
        `UPDATE berth_bookings SET status='cancelled', cancelled_at=now(), superseded_by=$2
         WHERE id=$1 AND status='booked'
         RETURNING ${BOOKING_COLUMNS}`,
        [input.bookingId, newId],
      );
      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO berth_bookings
             (id, review_id, voyage_id, discharge_port, berth, start_at, end_at,
              submission_no, adjustment_no, rescheduled_from, manifest_rev, port_box_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11)
           RETURNING ${BOOKING_COLUMNS}`,
          [
            newId,
            original.review_id,
            original.voyage_id,
            original.discharge_port,
            input.berth,
            window.start!.toISOString(),
            window.end!.toISOString(),
            input.adjustmentNo,
            input.bookingId,
            original.manifest_rev,
            original.port_box_count,
          ],
        );
      } catch (err) {
        // 语句报错后当前事务已中止：回滚即恢复原预订（释放旧窗口与占用新窗口同生共死），
        // 再在事务外补充冲突明细（不能在已中止事务里继续查询）。
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        releasedEarly = true;
        const mapped = await mapRescheduleConflict(err, this.pool, input, original);
        if (mapped) throw mapped;
        throw err;
      }

      const superseded = supersededRes.rows[0] as BookingRow;
      const row = inserted.rows[0] as BookingRow;
      await client.query('COMMIT');
      return { replay: false, booking: bookingToJson(row), superseded: bookingToJson(superseded) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      if (!releasedEarly) client.release();
    }
  }

  /** 取单条预订（含状态） */
  async getBooking(bookingId: string) {
    const res = await this.pool.query(
      `SELECT ${BOOKING_COLUMNS}
       FROM berth_bookings WHERE id=$1`,
      [bookingId],
    );
    if (res.rows.length === 0) {
      throw HttpError.notFound('berth_booking_not_found', `靠泊预订 ${bookingId} 不存在`);
    }
    return { booking: bookingToJson(res.rows[0] as BookingRow) };
  }

  /** 按卸货审查查询预订与状态 */
  async listByReview(reviewId: string) {
    const client = await this.pool.connect();
    try {
      const review = await client.query(`SELECT voyage_id FROM discharge_reviews WHERE id=$1`, [
        reviewId,
      ]);
      if (review.rows.length === 0) {
        throw HttpError.notFound(
          'discharge_review_not_found',
          `卸货审查 ${reviewId} 不存在`,
        );
      }
      const res = await client.query(
        `SELECT ${BOOKING_COLUMNS}
         FROM berth_bookings WHERE review_id=$1 ORDER BY start_at, created_at`,
        [reviewId],
      );
      return {
        reviewId,
        voyageId: review.rows[0].voyage_id as string,
        bookings: (res.rows as BookingRow[]).map(bookingToJson),
      };
    } finally {
      client.release();
    }
  }

  /** 按航次查询预订与状态（含该航次各审查下的预订） */
  async listByVoyage(voyageId: string) {
    const check = await this.pool.query(`SELECT 1 FROM voyages WHERE id=$1`, [voyageId]);
    if (check.rows.length === 0) {
      throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
    }
    const res = await this.pool.query(
      `SELECT ${BOOKING_COLUMNS}
       FROM berth_bookings WHERE voyage_id=$1 ORDER BY start_at, created_at`,
      [voyageId],
    );
    return { voyageId, bookings: (res.rows as BookingRow[]).map(bookingToJson) };
  }
}
