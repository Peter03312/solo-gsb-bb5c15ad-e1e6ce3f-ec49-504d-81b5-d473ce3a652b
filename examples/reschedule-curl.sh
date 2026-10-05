#!/usr/bin/env bash
# 靠泊预订改期 —— curl 调用示例
#
# 港口调度员调整【已生效】的靠泊预订：提交原预订 ID（路径）、新泊位、带时区起止时刻与调整号。
#   - 仅在原预订仍有效（booked）时受理；受理后旧记录保留为已取消并以 supersededBy 关联新记录，
#     新记录继承原审查、卸港及冻结的清单修订号与实际卸箱数；
#   - 释放旧窗口与占用新窗口在同一事务内原子完成：无效时刻、已取消原预订、调整号冲突或
#     新窗口被占用时，原预订保持不变；
#   - 新窗口沿用同一套规则：同审查同港至多一个有效预订、同港同泊位（跨航次）半开区间不重叠、
#     首尾相接可用；新窗口允许与原窗口自身重叠/相接（旧窗口已同事务释放）；
#   - 调整号在同一原预订内唯一：同号同内容重试 -> 200 replay:true 返回新记录当前状态；
#     同号改内容 -> 409 booking_adjustment_conflict；起止时刻按绝对瞬间比较。
#
# 前置：无。本脚本自包含：登记航次 -> 配载 -> 签发清单 -> 创建可行卸货审查 -> 首次预订。
#
# 用法: BASE=http://localhost:3000 bash examples/reschedule-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：登记航次 + 配载 rev1 + 签发清单 + 可行卸货审查 + 首次预订
say "0) 准备：登记航次 + 配载 + 签发清单(rev=1) + 卸货审查 + 首次预订 SIN/B-7"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-RESCHED-'"$(date +%s)"'",
  "bays": 2, "rows": 1, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500", "category": "1" },
    { "boxNo": "BOX-2", "weight": "500", "category": "1" },
    { "boxNo": "BOX-3", "weight": "500", "category": "1" },
    { "boxNo": "BOX-4", "weight": "500", "category": "1" }
  ]
}')
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 2 } },
    { "boxNo": "BOX-4", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' >/dev/null

REVIEW_JSON=$(curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-reviews" \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SIN" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "SHA" },
    { "boxNo": "BOX-4", "dischargePort": "HAM" }
  ]
}')
RID=$(echo "$REVIEW_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$RID"

BOOK_JSON=$(curl -sS -X POST "$API/discharge-reviews/$RID/berth-bookings" \
  -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}')
BID=$(echo "$BOOK_JSON" | sed -n 's/.*"bookingId":"\([^"]*\)".*/\1/p' | head -1)
echo "bookingId=$BID（SIN / B-7 / 2026-10-10 08:00-12:00 +08:00）"

# 1. 首次改期：B-7 -> B-8，窗口移到 10-12；旧记录取消并关联新记录，新记录继承冻结快照
say "1) 改期 $BID -> B-8 / 2026-10-12 08:00-12:00 +08:00 / 调整号 ADJ-001"
RESCHED_JSON=$(curl -sS -X POST "$API/berth-bookings/$BID/reschedule" \
  -H 'content-type: application/json' -d '{
  "berth": "B-8",
  "startAt": "2026-10-12T08:00:00+08:00",
  "endAt":   "2026-10-12T12:00:00+08:00",
  "adjustmentNo": "ADJ-001"
}')
echo "$RESCHED_JSON" | jq_or_cat
NBID=$(echo "$RESCHED_JSON" | sed -n 's/.*"booking":{[^}]*"bookingId":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$NBID" ]; then NBID=$(echo "$RESCHED_JSON" | sed -n 's/.*"bookingId":"\([^"]*\)".*/\1/p' | head -1); fi
echo "newBookingId=$NBID"

# 2. 同调整号同内容重试（等效时区写法）-> 200 replay:true，返回新记录当前状态
say "2) 同调整号 + 同内容（UTC 等效写法）重试 -> replay:true，返回新记录当前状态"
curl -sS -X POST "$API/berth-bookings/$BID/reschedule" -H 'content-type: application/json' -d '{
  "berth": "B-8",
  "startAt": "2026-10-12T00:00:00Z",
  "endAt":   "2026-10-12T04:00:00Z",
  "adjustmentNo": "ADJ-001"
}' | jq_or_cat

# 3. 同调整号改内容 -> 409 booking_adjustment_conflict
say "3) 同调整号改泊位 -> 409 booking_adjustment_conflict"
curl -sS -X POST "$API/berth-bookings/$BID/reschedule" -H 'content-type: application/json' -d '{
  "berth": "B-9",
  "startAt": "2026-10-12T08:00:00+08:00",
  "endAt":   "2026-10-12T12:00:00+08:00",
  "adjustmentNo": "ADJ-001"
}' | jq_or_cat

# 4. 链式改期：对新记录再改期；新窗口与原窗口自身重叠也允许（原子换窗）
say "4) 对新记录 $NBID 再改期（窗口与自身原窗口部分重叠）-> 201"
curl -sS -X POST "$API/berth-bookings/$NBID/reschedule" -H 'content-type: application/json' -d '{
  "berth": "B-8",
  "startAt": "2026-10-12T10:00:00+08:00",
  "endAt":   "2026-10-12T14:00:00+08:00",
  "adjustmentNo": "ADJ-002"
}' | jq_or_cat

# 5. 已取消（已被替换）的原预订再改期 -> 409 booking_not_active，原预订不变
say "5) 已被替换的原预订 $BID 用新调整号再改期 -> 409 booking_not_active"
curl -sS -X POST "$API/berth-bookings/$BID/reschedule" -H 'content-type: application/json' -d '{
  "berth": "B-10",
  "startAt": "2026-11-01T08:00:00Z",
  "endAt":   "2026-11-01T10:00:00Z",
  "adjustmentNo": "ADJ-009"
}' | jq_or_cat

# 6. 无效时刻 -> 400 invalid_time_window，原预订不变
say "6) 缺少时区的时刻 -> 400 invalid_time_window（原预订不变）"
curl -sS -X POST "$API/berth-bookings/$NBID/reschedule" -H 'content-type: application/json' -d '{
  "berth": "B-8",
  "startAt": "2026-10-13T08:00:00",
  "endAt":   "2026-10-13T09:00:00",
  "adjustmentNo": "ADJ-003"
}' | jq_or_cat

# 7. 查询：单条（旧记录已取消并关联新记录）/ 按审查列表（全链路保留）
say "7) 查询原预订 $BID（cancelled + supersededBy 指向新记录）"
curl -sS "$API/berth-bookings/$BID" | jq_or_cat
say "7b) 按审查查询预订列表（改期链全部保留）"
curl -sS "$API/discharge-reviews/$RID/berth-bookings" | jq_or_cat

# 8. 原提交号重试保持兼容：返回原预订当前状态（已取消）
say "8) 原提交号 SUB-001 同内容重试 -> replay:true 返回原预订当前状态（cancelled）"
curl -sS -X POST "$API/discharge-reviews/$RID/berth-bookings" \
  -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}' | jq_or_cat

echo
echo "完成。"
