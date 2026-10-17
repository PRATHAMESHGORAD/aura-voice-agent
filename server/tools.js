// Mock order DB + tools. Policy decisions are computed HERE (deterministically),
// the LLM only phrases the result. This is the core guardrail.

const ORDERS = {
  'ORD-101': { order_id: 'ORD-101', customer: 'Priya Sharma', product: 'Vitamin C Serum (30ml)', value_inr: 699,
    status: 'Out for Delivery', carrier: 'BlueDart', tracking_id: 'BD-982103', note: 'Expected by 6 PM today' },
  'ORD-102': { order_id: 'ORD-102', customer: 'Rahul Verma', product: 'Hydrating Sunscreen SPF 50', value_inr: 499,
    status: 'Delivered', carrier: 'Delhivery', tracking_id: 'DL-441029', delivered_days_ago: 14 },
  'ORD-103': { order_id: 'ORD-103', customer: 'Ananya Patel', product: 'Green Tea Face Wash + Toner', value_inr: 850,
    status: 'Processing', placed_hours_ago: 3, note: 'Not yet shipped. Can still be cancelled.' },
};

const sessions = new Map(); // sessionId -> Set of cancelled order ids (so tests don't pollute each other)

export function normalizeId(raw) {
  const digits = String(raw ?? '').match(/\d{3,}/);
  return digits ? `ORD-${digits[0]}` : null;
}

function lookup(rawId, sessionId) {
  const id = normalizeId(rawId);
  if (!id) return { error: 'missing_or_invalid_id' };
  const base = ORDERS[id];
  if (!base) return { error: 'not_found', id };
  const order = { ...base };
  if (sessions.get(sessionId)?.has(id)) order.status = 'Cancelled';
  return { order };
}

export function getOrderDetails({ order_id }, sessionId) {
  const { order, error, id } = lookup(order_id, sessionId);
  if (error === 'missing_or_invalid_id') return { found: false, reason: 'No valid order ID was provided. Ask the customer for it.' };
  if (error === 'not_found') return { found: false, order_id: id, reason: 'No order exists with this ID. Ask the customer to verify it.' };
  return { found: true, ...order };
}

export function checkReturnEligibility({ order_id, reason = 'change_of_mind', opened }, sessionId) {
  const { order, error, id } = lookup(order_id, sessionId);
  if (error) return { found: false, order_id: id ?? null, reason: 'Order not found or ID missing.' };
  if (order.status !== 'Delivered')
    return { found: true, order_id: order.order_id, status: order.status, eligible: false,
      reason: 'Returns are only possible after delivery. If Processing it can be cancelled; if Shipped/Out for Delivery the customer may refuse delivery at the doorstep.' };

  const days = order.delivered_days_ago;
  if (reason === 'damaged_or_defective') {
    const ok = days * 24 <= 48;
    return { found: true, order_id: order.order_id, delivered_days_ago: days, eligible: ok,
      reason: ok ? 'Within the 48-hour window. Customer must share photos for a replacement (not a refund).'
                 : 'Damage/defect must be reported within 48 hours of delivery with photos. This is outside that window.' };
  }
  if (days > 7)
    return { found: true, order_id: order.order_id, delivered_days_ago: days, eligible: false,
      reason: `Delivered ${days} days ago. Returns are accepted only within 7 days of delivery.` };
  if (opened === undefined || opened === null)
    return { found: true, order_id: order.order_id, delivered_days_ago: days, eligible: null,
      reason: 'Within 7 days. Ask whether the product is unopened, unused and in original packaging, then call again with opened set.' };
  return { found: true, order_id: order.order_id, delivered_days_ago: days, eligible: !opened,
    reason: opened ? 'Opened/used products cannot be returned.' : 'Eligible: within 7 days, unopened and unused. Product must be in original packaging.' };
}

export function cancelOrder({ order_id }, sessionId) {
  const { order, error, id } = lookup(order_id, sessionId);
  if (error) return { found: false, order_id: id ?? null, success: false, reason: 'Order not found or ID missing.' };
  if (order.status !== 'Processing')
    return { found: true, order_id: order.order_id, success: false, status: order.status,
      reason: order.status === 'Cancelled' ? 'Already cancelled.'
        : 'Only Processing orders can be cancelled. The customer may refuse delivery at the doorstep.' };
  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId).add(order.order_id);
  return { found: true, order_id: order.order_id, success: true, status: 'Cancelled' };
}

const fns = { get_order_details: getOrderDetails, check_return_eligibility: checkReturnEligibility, cancel_order: cancelOrder };

export function runTool(name, args, sessionId) {
  const fn = fns[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try { return fn(args || {}, sessionId); } catch (e) { return { error: e.message }; }
}

const idParam = { type: 'string', description: 'Order ID such as ORD-101. Digits alone (e.g. 101) are accepted.' };
export const TOOLS = [
  { type: 'function', function: { name: 'get_order_details',
    description: 'Look up an order: status, product, value, carrier, tracking and delivery notes. Use for any order-specific question.',
    parameters: { type: 'object', properties: { order_id: idParam }, required: ['order_id'] } } },
  { type: 'function', function: { name: 'check_return_eligibility',
    description: 'Check if an order can be returned/replaced under policy. Always use this instead of judging return eligibility yourself.',
    parameters: { type: 'object', properties: {
      order_id: idParam,
      reason: { type: 'string', enum: ['change_of_mind', 'damaged_or_defective'] },
      opened: { type: 'boolean', description: 'Whether the customer has opened/used the product. Omit if not yet asked.' } },
      required: ['order_id'] } } },
  { type: 'function', function: { name: 'cancel_order',
    description: 'Cancel an order. Only call after the customer has clearly confirmed they want to cancel.',
    parameters: { type: 'object', properties: { order_id: idParam }, required: ['order_id'] } } },
];
