/* eslint-disable no-console */
// 靠泊预订改期 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-reschedule.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30199;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

/** 登记航次 + 配载 + 签发 rev1（清单 4 箱） */
async function setupVoyage(voyageNo) {
  const { body: voyage } = await http('POST', `${BASE}/voyages`, {
    voyageNo,
    bays: 2, rows: 1, tiers: 3,
    defaultColumnWeightLimit: '10000',
    boxes: [
      { boxNo: 'BOX-1', weight: '500', category: '1' },
      { boxNo: 'BOX-2', weight: '500', category: '1' },
      { boxNo: 'BOX-3', weight: '500', category: '1' },
      { boxNo: 'BOX-4', weight: '500', category: '1' },
    ],
  }, 201);
  const vid = voyage.id;
  await http('POST', `${BASE}/voyages/${vid}/moves`, {
    baseRevision: 0,
    moves: [
      { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
      { boxNo: 'BOX-2', position: { bay: 1, row: 1, tier: 1 } },
      { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 2 } },
      { boxNo: 'BOX-4', position: { bay: 2, row: 1, tier: 0 } },
    ],
  }, 200);
  await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 }, 201);
  return vid;
}

const GOOD_ITEMS = [
  { boxNo: 'BOX-1', dischargePort: 'SIN' },
  { boxNo: 'BOX-2', dischargePort: 'SIN' },
  { boxNo: 'BOX-3', dischargePort: 'SHA' },
  { boxNo: 'BOX-4', dischargePort: 'HAM' },
];

async function createReview(vid) {
  const { body } = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`, {
    ports: ['SHA', 'SIN', 'HAM'],
    items: GOOD_ITEMS,
  }, 201);
  return body.reviewId;
}

async function book(reviewId, port, berth, startAt, endAt, submissionNo, expected = 201) {
  const r = await http('POST', `${BASE}/discharge-reviews/${reviewId}/berth-bookings`, {
    reviewId, dischargePort: port, berth, startAt, endAt, submissionNo,
  }, expected);
  return r;
}

async function reschedule(bookingId, berth, startAt, endAt, adjustmentNo, expected) {
  return http('POST', `${BASE}/berth-bookings/${bookingId}/reschedule`, {
    berth, startAt, endAt, adjustmentNo,
  }, expected);
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-reschedule'),
    user: 'stowage',
    password: 'stowage',
    port: 54399,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54399/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 准备：五个航次 + 各自的可行卸货审查 ----
    const vid1 = await setupVoyage('V-E2E-RS-001');
    const review1 = await createReview(vid1);
    const vid2 = await setupVoyage('V-E2E-RS-002');
    const review2 = await createReview(vid2);
    const vid3 = await setupVoyage('V-E2E-RS-003');
    const review3 = await createReview(vid3);
    const vid4 = await setupVoyage('V-E2E-RS-004');
    const review4 = await createReview(vid4);
    const vid5 = await setupVoyage('V-E2E-RS-005');
    const review5 = await createReview(vid5);

    // review1 SIN：主改期链 A -> B -> C
    const a = (await book(review1, 'SIN', 'B-7',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'SUB-001')).body;
    check('原预订 A 建立（SIN/B-7，冻结 rev1/卸箱2）',
      a.status === 'booked' && a.frozenManifestRevision === 1 && a.dischargedBoxCount === 2 &&
      a.adjustmentNo === null && a.rescheduledFrom === null && a.supersededBy === null);

    // ---- 1. 首次改期成功：原子换窗 + 继承冻结快照 ----
    const r1 = await reschedule(a.bookingId, 'B-8',
      '2026-10-12T08:00:00+08:00', '2026-10-12T12:00:00+08:00', 'ADJ-001', 201);
    check('首次改期 201 rescheduled=true replay=false',
      r1.body.rescheduled === true && r1.body.replay === false);
    const b = r1.body.booking;
    check('新记录：新 ID、booked、继承审查/航次/卸港',
      b.bookingId !== a.bookingId && b.status === 'booked' && b.open === true &&
      b.reviewId === review1 && b.voyageId === vid1 && b.dischargePort === 'SIN');
    check('新记录：继承冻结的清单修订号与实际卸箱数',
      b.frozenManifestRevision === 1 && b.dischargedBoxCount === 2);
    check('新记录：adjustmentNo/rescheduledFrom 关联，submissionNo 为空',
      b.adjustmentNo === 'ADJ-001' && b.rescheduledFrom === a.bookingId && b.submissionNo === null);
    check('新记录：新泊位与窗口按绝对时刻 UTC 回显',
      b.berth === 'B-8' && b.startAt === '2026-10-12T00:00:00.000Z' &&
      b.endAt === '2026-10-12T04:00:00.000Z', JSON.stringify({ s: b.startAt, e: b.endAt }));
    const sup1 = r1.body.superseded;
    check('旧记录：保留为已取消并关联新记录（supersededBy）',
      sup1.bookingId === a.bookingId && sup1.status === 'cancelled' && !!sup1.cancelledAt &&
      sup1.supersededBy === b.bookingId && sup1.submissionNo === 'SUB-001');

    // ---- 2. 原子性：旧窗口已释放、新窗口被占用 ----
    const freed = await book(review2, 'SIN', 'B-7',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'R2-OLDWIN', 201);
    check('旧窗口已释放：另一航次同港同泊位同时段可订', freed.body.status === 'booked');

    const occupied = await http('POST', `${BASE}/discharge-reviews/${review4}/berth-bookings`, {
      reviewId: review4, dischargePort: 'SIN', berth: 'B-8',
      startAt: '2026-10-12T10:00:00+08:00', endAt: '2026-10-12T11:00:00+08:00',
      submissionNo: 'R4-NEWIN',
    });
    check('新窗口被占用：另一航次撞新窗口 -> 409 berth_window_overlap（冲突方=新记录）',
      occupied.status === 409 && occupied.body.error.code === 'berth_window_overlap' &&
      occupied.body.error.details.conflicting.bookingId === b.bookingId,
      JSON.stringify(occupied.body));

    // ---- 3. 同调整号同内容重试（等效时区）-> 200 replay 返回新记录当前状态 ----
    const replay1 = await reschedule(a.bookingId, 'B-8',
      '2026-10-12T00:00:00Z', '2026-10-12T12:00:00+08:00', 'ADJ-001', 200);
    check('同号同内容（等效时区）replay=true 返回新记录（仍 booked）',
      replay1.body.replay === true && replay1.body.booking.bookingId === b.bookingId &&
      replay1.body.booking.status === 'booked' &&
      replay1.body.superseded.bookingId === a.bookingId);

    // ---- 4. 同调整号改内容 -> 409 booking_adjustment_conflict ----
    const adjConflict = await reschedule(a.bookingId, 'B-9',
      '2026-10-12T08:00:00+08:00', '2026-10-12T12:00:00+08:00', 'ADJ-001');
    check('同号改泊位 -> 409 booking_adjustment_conflict',
      adjConflict.status === 409 && adjConflict.body.error.code === 'booking_adjustment_conflict');

    // ---- 5. 链式改期：新记录仍有效可再改；新窗口与原窗口自身重叠允许（原子换窗）----
    const r2 = await reschedule(b.bookingId, 'B-8',
      '2026-10-12T10:00:00+08:00', '2026-10-12T14:00:00+08:00', 'ADJ-002', 201);
    const c = r2.body.booking;
    check('链式改期成功：新窗口与原窗口自身部分重叠也允许（先释放后占用）',
      c.status === 'booked' && c.berth === 'B-8' &&
      c.startAt === '2026-10-12T02:00:00.000Z' && c.endAt === '2026-10-12T06:00:00.000Z' &&
      c.rescheduledFrom === b.bookingId && c.adjustmentNo === 'ADJ-002' &&
      c.frozenManifestRevision === 1 && c.dischargedBoxCount === 2);
    check('中间记录 B 已取消并关联 C',
      r2.body.superseded.bookingId === b.bookingId && r2.body.superseded.status === 'cancelled' &&
      r2.body.superseded.supersededBy === c.bookingId);

    // 重放第一环调整号：返回新记录 B 的【当前状态】（B 已被 C 替换 -> cancelled）
    const replayChain = await reschedule(a.bookingId, 'B-8',
      '2026-10-12T08:00:00+08:00', '2026-10-12T12:00:00+08:00', 'ADJ-001', 200);
    check('链式后重放 ADJ-001：返回 B 的当前状态（cancelled + supersededBy=C）',
      replayChain.body.booking.bookingId === b.bookingId &&
      replayChain.body.booking.status === 'cancelled' &&
      replayChain.body.booking.supersededBy === c.bookingId,
      JSON.stringify(replayChain.body.booking));

    // ---- 6. 已取消原预订改期 -> 409 booking_not_active，原预订不变 ----
    const notActive = await reschedule(a.bookingId, 'B-99',
      '2026-11-01T08:00:00Z', '2026-11-01T09:00:00Z', 'ADJ-009');
    check('已被改期替换的原预订再改期（新调整号）-> 409 booking_not_active',
      notActive.status === 409 && notActive.body.error.code === 'booking_not_active');
    const aAfter = await http('GET', `${BASE}/berth-bookings/${a.bookingId}`, undefined, 200);
    check('拒绝后原预订不变（仍 cancelled、supersededBy 仍指向 B）',
      aAfter.body.booking.status === 'cancelled' && aAfter.body.booking.supersededBy === b.bookingId);

    // 取消后再改期同样拒绝
    const h1 = (await book(review1, 'HAM', 'B-2',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'SUB-002')).body;
    await http('POST', `${BASE}/berth-bookings/${h1.bookingId}/cancel`, undefined, 200);
    const cancelThenReschedule = await reschedule(h1.bookingId, 'B-3',
      '2026-10-11T08:00:00+08:00', '2026-10-11T12:00:00+08:00', 'ADJ-H1');
    check('已取消预订改期 -> 409 booking_not_active',
      cancelThenReschedule.status === 409 &&
      cancelThenReschedule.body.error.code === 'booking_not_active');
    const h1After = await http('GET', `${BASE}/berth-bookings/${h1.bookingId}`, undefined, 200);
    check('取消后改期被拒：原记录无 supersededBy（未被替换）',
      h1After.body.booking.status === 'cancelled' && h1After.body.booking.supersededBy === null);

    // ---- 7. 无效时刻 -> 400 invalid_time_window，原预订不变 ----
    const noTz = await reschedule(c.bookingId, 'B-8',
      '2026-10-13T08:00:00', '2026-10-13T09:00:00', 'ADJ-003');
    check('无时区时刻 -> 400 invalid_time_window(unparsable_time)',
      noTz.status === 400 && noTz.body.error.code === 'invalid_time_window' &&
      noTz.body.error.details.issues.some((i) => i.reason === 'unparsable_time'));
    const badOrder = await reschedule(c.bookingId, 'B-8',
      '2026-10-13T09:00:00Z', '2026-10-13T08:00:00Z', 'ADJ-003');
    check('起点不早于终点 -> 400 start_not_before_end',
      badOrder.status === 400 &&
      badOrder.body.error.details.issues.some((i) => i.reason === 'start_not_before_end'));
    const cAfterTime = await http('GET', `${BASE}/berth-bookings/${c.bookingId}`, undefined, 200);
    check('无效时刻被拒后原预订不变（C 仍 booked）',
      cAfterTime.body.booking.status === 'booked' && cAfterTime.body.booking.supersededBy === null);

    // ---- 8. 新窗口被占用 -> 409 berth_window_overlap，原预订不变 ----
    const blocker = (await book(review3, 'SIN', 'B-20',
      '2026-10-15T08:00:00+08:00', '2026-10-15T12:00:00+08:00', 'R3-B20')).body;
    const occupiedReschedule = await reschedule(c.bookingId, 'B-20',
      '2026-10-15T10:00:00+08:00', '2026-10-15T13:00:00+08:00', 'ADJ-003');
    check('新窗口被占用 -> 409 berth_window_overlap（含冲突方）',
      occupiedReschedule.status === 409 && occupiedReschedule.body.error.code === 'berth_window_overlap' &&
      occupiedReschedule.body.error.details.conflicting.bookingId === blocker.bookingId,
      JSON.stringify(occupiedReschedule.body));
    const cAfterOverlap = await http('GET', `${BASE}/berth-bookings/${c.bookingId}`, undefined, 200);
    check('窗口被占用被拒后原预订不变（C 仍 booked 占原窗）',
      cAfterOverlap.body.booking.status === 'booked' &&
      cAfterOverlap.body.booking.startAt === '2026-10-12T02:00:00.000Z');

    // 冲突明细排除原预订自身：X 改到与自身及 Y 都重叠的窗口，409 明细应指向 Y 而非 X
    const x = (await book(review1, 'SHA', 'B-30',
      '2026-10-20T08:00:00+08:00', '2026-10-20T12:00:00+08:00', 'SUB-003')).body;
    const y = (await book(review2, 'SHA', 'B-30',
      '2026-10-20T13:00:00+08:00', '2026-10-20T15:00:00+08:00', 'R2-B30')).body;
    const selfOverlap = await reschedule(x.bookingId, 'B-30',
      '2026-10-20T10:00:00+08:00', '2026-10-20T14:00:00+08:00', 'ADJ-100');
    check('与自身及他人同时重叠：409 明细指向他人 Y（排除原预订自身）',
      selfOverlap.status === 409 && selfOverlap.body.error.code === 'berth_window_overlap' &&
      selfOverlap.body.error.details.conflicting.bookingId === y.bookingId,
      JSON.stringify(selfOverlap.body));
    const xAfter = await http('GET', `${BASE}/berth-bookings/${x.bookingId}`, undefined, 200);
    check('冲突失败后 X 仍 booked 占原窗', xAfter.body.booking.status === 'booked');

    // 失败不消耗调整号：同调整号修正为首尾相接窗口（Y 15:00 结束）后成功
    const xFixed = await reschedule(x.bookingId, 'B-30',
      '2026-10-20T15:00:00+08:00', '2026-10-20T16:00:00+08:00', 'ADJ-100', 201);
    check('失败后可修正重试：首尾相接（Y 终点=新起点）允许',
      xFixed.body.booking.status === 'booked' &&
      xFixed.body.booking.startAt === '2026-10-20T07:00:00.000Z');

    // ---- 9. 同审查同港唯一：链头 C 有效期间，同审查同港新预订被拒 ----
    const dupPort = await http('POST', `${BASE}/discharge-reviews/${review1}/berth-bookings`, {
      reviewId: review1, dischargePort: 'SIN', berth: 'B-99',
      startAt: '2026-10-13T08:00:00+08:00', endAt: '2026-10-13T09:00:00+08:00',
      submissionNo: 'SUB-009',
    });
    check('改期后同审查同港仍有有效预订（链头 C）-> 409 booking_exists_for_port',
      dupPort.status === 409 && dupPort.body.error.code === 'booking_exists_for_port' &&
      dupPort.body.error.details.existingBooking.bookingId === c.bookingId,
      JSON.stringify(dupPort.body));

    // ---- 10. 并发改期同一预订（不同调整号）：只成功一方 ----
    const p = (await book(review5, 'SIN', 'B-50',
      '2026-11-01T08:00:00Z', '2026-11-01T10:00:00Z', 'R5-P')).body;
    const concurrent = await Promise.all([
      reschedule(p.bookingId, 'B-51', '2026-11-02T08:00:00Z', '2026-11-02T10:00:00Z', 'ADJ-C1'),
      reschedule(p.bookingId, 'B-52', '2026-11-03T08:00:00Z', '2026-11-03T10:00:00Z', 'ADJ-C2'),
    ]);
    const cStatuses = concurrent.map((r) => r.status).sort();
    check('并发改期：一方 201、一方 409',
      JSON.stringify(cStatuses) === JSON.stringify([201, 409]), JSON.stringify(cStatuses));
    check('失败方为 booking_not_active（原预订只被替换一次）',
      concurrent.some((r) => r.status === 409 && r.body.error.code === 'booking_not_active'));
    const winner = concurrent.find((r) => r.status === 201).body.booking;
    const pAfter = await http('GET', `${BASE}/berth-bookings/${p.bookingId}`, undefined, 200);
    check('原预订 P 已取消且 supersededBy 指向胜出新记录',
      pAfter.body.booking.status === 'cancelled' &&
      pAfter.body.booking.supersededBy === winner.bookingId);

    // ---- 11. 原提交号重试行为兼容：返回原预订当前状态（已取消+关联）----
    const subReplay = await book(review1, 'SIN', 'B-7',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'SUB-001', 200);
    check('原提交号同内容重试 -> replay 返回 A 当前状态（cancelled、supersededBy=B）',
      subReplay.body.replay === true && subReplay.body.bookingId === a.bookingId &&
      subReplay.body.status === 'cancelled' && subReplay.body.supersededBy === b.bookingId);

    // ---- 12. 冻结快照不回写：推进航次签发新清单后，链上各记录快照不变 ----
    await http('POST', `${BASE}/voyages/${vid1}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid1}/manifests`, { expectedRevision: 2 }, 201);
    const cFrozen = await http('GET', `${BASE}/berth-bookings/${c.bookingId}`, undefined, 200);
    check('签发新清单后改期新记录冻结快照不回写（仍 manifest=1、卸箱数=2）',
      cFrozen.body.booking.frozenManifestRevision === 1 &&
      cFrozen.body.booking.dischargedBoxCount === 2);

    // ---- 13. 取消新记录：释放新窗口与同港名额；重复取消幂等 ----
    const cancelC = await http('POST', `${BASE}/berth-bookings/${c.bookingId}/cancel`, undefined, 200);
    check('取消链头 C 成功', cancelC.body.booking.status === 'cancelled' && !!cancelC.body.booking.cancelledAt);
    const cancelCAgain = await http('POST', `${BASE}/berth-bookings/${c.bookingId}/cancel`, undefined, 200);
    check('重复取消幂等 replay=true', cancelCAgain.body.replay === true);

    const reuseWindow = await book(review4, 'SIN', 'B-8',
      '2026-10-12T10:00:00+08:00', '2026-10-12T11:00:00+08:00', 'R4-AFTER', 201);
    check('取消新记录后新窗口释放：另一航次可订同时段', reuseWindow.body.status === 'booked');
    const rebookPort = await book(review1, 'SIN', 'B-99',
      '2026-10-13T08:00:00+08:00', '2026-10-13T09:00:00+08:00', 'SUB-009', 201);
    check('取消新记录后同审查同港名额释放：新提交号可重新预订', rebookPort.body.status === 'booked');

    // ---- 14. 查询：列表含全链路记录与关联字段 ----
    const listReview = await http('GET', `${BASE}/discharge-reviews/${review1}/berth-bookings`, undefined, 200);
    const byId = Object.fromEntries(listReview.body.bookings.map((x) => [x.bookingId, x]));
    check('按审查查询：改期链 A/B/C 都在（记录保留）',
      !!byId[a.bookingId] && !!byId[b.bookingId] && !!byId[c.bookingId] &&
      byId[a.bookingId].supersededBy === b.bookingId &&
      byId[b.bookingId].supersededBy === c.bookingId &&
      byId[c.bookingId].rescheduledFrom === b.bookingId);
    const listVoyage = await http('GET', `${BASE}/voyages/${vid1}/berth-bookings`, undefined, 200);
    check('按航次查询包含改期产生的新记录',
      listVoyage.body.bookings.some((x) => x.bookingId === c.bookingId));

    // ---- 15. 未知/非法 ----
    const zero = '00000000-0000-0000-0000-000000000000';
    const noBooking = await reschedule(zero, 'B-1',
      '2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z', 'ADJ-X');
    check('未知预订改期 -> 404 berth_booking_not_found',
      noBooking.status === 404 && noBooking.body.error.code === 'berth_booking_not_found');
    const badId = await http('POST', `${BASE}/berth-bookings/not-a-uuid/reschedule`, {
      berth: 'B-1', startAt: '2026-10-20T08:00:00Z', endAt: '2026-10-20T09:00:00Z', adjustmentNo: 'A',
    });
    check('非法预订 ID -> 400 invalid_berth_booking_id',
      badId.status === 400 && badId.body.error.code === 'invalid_berth_booking_id');
    const missingField = await http('POST', `${BASE}/berth-bookings/${winner.bookingId}/reschedule`, {
      berth: 'B-1', startAt: '2026-10-20T08:00:00Z', endAt: '2026-10-20T09:00:00Z',
    });
    check('缺调整号 -> 400 invalid_request_body',
      missingField.status === 400 && missingField.body.error.code === 'invalid_request_body');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
