import type {
  PromotionAllocation,
  PromotionCandidate,
  PromotionCartLine,
  PromotionConfig,
  PromotionContext,
  PromotionEvaluation,
  PromotionTier,
  PromotionTarget,
} from "./types";

const BASIS_POINTS = BigInt(10_000);

function safeAmount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function lineTotal(line: PromotionCartLine): number {
  if (line.lineSubtotalPaise !== undefined) return Number.isSafeInteger(line.lineSubtotalPaise) ? Math.max(0, line.lineSubtotalPaise ?? 0) : 0;
  return Number.isSafeInteger(line.unitPricePaise * line.quantity) ? Math.max(0, line.unitPricePaise * line.quantity) : 0;
}

function roundedBasisPoints(amount: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isInteger(basisPoints) || basisPoints <= 0) return 0;
  const rounded = (BigInt(amount) * BigInt(basisPoints) + BASIS_POINTS / BigInt(2)) / BASIS_POINTS;
  return Number(rounded > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : rounded);
}

function matchesDimension(line: PromotionCartLine, target: PromotionTarget): boolean {
  switch (target.dimension) {
    case "PRODUCT": return line.productId === target.entityId;
    case "CATEGORY": return line.categoryIds.includes(target.entityId);
    case "BRAND": return line.brandId === target.entityId;
    case "SELLER": return line.sellerId === target.entityId;
    case "COLLECTION": return line.collectionIds.includes(target.entityId);
    case "CUSTOMER": return false;
  }
}

function customerMatches(targets: readonly PromotionTarget[], userId: string | null): boolean {
  const customerTargets = targets.filter((target) => target.dimension === "CUSTOMER");
  if (!customerTargets.length) return true;
  if (!userId) return false;
  const includes = customerTargets.filter((target) => target.mode === "INCLUDE");
  const excludes = customerTargets.filter((target) => target.mode === "EXCLUDE");
  if (excludes.some((target) => target.entityId === userId)) return false;
  return includes.length === 0 || includes.some((target) => target.entityId === userId);
}

function lineMatchesTargets(line: PromotionCartLine, targets: readonly PromotionTarget[]): boolean {
  const productDimensions = ["PRODUCT", "CATEGORY", "BRAND", "SELLER", "COLLECTION"] as const;
  for (const dimension of productDimensions) {
    const entries = targets.filter((target) => target.dimension === dimension);
    if (!entries.length) continue;
    const includes = entries.filter((target) => target.mode === "INCLUDE");
    const excludes = entries.filter((target) => target.mode === "EXCLUDE");
    if (excludes.some((target) => matchesDimension(line, target))) return false;
    if (includes.length && !includes.some((target) => matchesDimension(line, target))) return false;
  }
  return true;
}

function totalRemaining(lines: readonly PromotionCartLine[], applied: ReadonlyMap<string, number>): number {
  return lines.reduce((sum, line) => sum + Math.max(0, lineTotal(line) - (applied.get(line.id) ?? 0)), 0);
}

function remainingLineTotals(
  lines: readonly PromotionCartLine[],
  eligible: readonly PromotionCartLine[],
  applied: ReadonlyMap<string, number>,
): Array<{ id: string; amountPaise: number }> {
  const allowed = new Set(eligible.map((line) => line.id));
  return lines
    .filter((line) => allowed.has(line.id))
    .map((line) => ({ id: line.id, amountPaise: Math.max(0, lineTotal(line) - (applied.get(line.id) ?? 0)) }))
    .filter((line) => line.amountPaise > 0);
}

/** Largest-remainder allocation: exact total, capped by each line, stable on ties. */
function allocateProportionally(
  amountPaise: number,
  lines: readonly { id: string; amountPaise: number }[],
): Record<string, number> {
  const total = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  const requested = Math.min(safeAmount(amountPaise), total);
  if (requested <= 0 || total <= 0) return {};
  const totalBig = BigInt(total);
  const entries = lines.map((line) => {
    const product = BigInt(requested) * BigInt(line.amountPaise);
    return {
      id: line.id,
      cap: line.amountPaise,
      allocated: Number(product / totalBig),
      remainder: product % totalBig,
    };
  });
  let residual = requested - entries.reduce((sum, entry) => sum + entry.allocated, 0);
  entries.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  for (const entry of entries) {
    if (residual <= 0) break;
    if (entry.allocated < entry.cap) {
      entry.allocated += 1;
      residual -= 1;
    }
  }
  return Object.fromEntries(entries.filter((entry) => entry.allocated > 0).map((entry) => [entry.id, entry.allocated]));
}

function sumAllocations(allocations: Readonly<Record<string, number>>): number {
  return Object.values(allocations).reduce((sum, amount) => sum + amount, 0);
}

function boundedDiscount(
  lines: readonly PromotionCartLine[],
  eligibleLines: readonly PromotionCartLine[],
  applied: ReadonlyMap<string, number>,
  rawAmount: number,
  maxDiscountPaise?: number | null,
): Record<string, number> {
  const available = remainingLineTotals(lines, eligibleLines, applied);
  const amount = Math.min(safeAmount(rawAmount), maxDiscountPaise == null ? Number.MAX_SAFE_INTEGER : safeAmount(maxDiscountPaise));
  return allocateProportionally(amount, available);
}

function discountedAmount(
  total: number,
  discountType: "PERCENTAGE" | "FIXED_AMOUNT",
  value: number,
  maxDiscountPaise?: number | null,
): number {
  const discount = discountType === "PERCENTAGE" ? roundedBasisPoints(total, value) : safeAmount(value);
  return maxDiscountPaise == null ? discount : Math.min(discount, safeAmount(maxDiscountPaise));
}

function chooseTier(config: Extract<PromotionConfig, { strategy: "QUANTITY_TIER" }>, quantity: number): PromotionTier | null {
  return [...config.tiers].sort((a, b) => a.minQuantity - b.minQuantity).filter((tier) => quantity >= tier.minQuantity).at(-1) ?? null;
}

function remainingUnitPrices(line: PromotionCartLine, remainingTotal: number): number[] {
  const quantity = Math.max(0, Math.min(line.quantity, 10_000));
  if (quantity === 0 || remainingTotal <= 0) return [];
  const floor = Math.floor(remainingTotal / quantity);
  const remainder = remainingTotal % quantity;
  return Array.from({ length: quantity }, (_, index) => floor + (index < remainder ? 1 : 0));
}

function buyXGetYAllocation(
  config: Extract<PromotionConfig, { strategy: "BUY_X_GET_Y" }>,
  lines: readonly PromotionCartLine[],
  eligible: readonly PromotionCartLine[],
  applied: ReadonlyMap<string, number>,
): Record<string, number> {
  const eligibleIds = new Set(eligible.map((line) => line.id));
  const units = lines
    .filter((line) => eligibleIds.has(line.id))
    .flatMap((line) => remainingUnitPrices(line, Math.max(0, lineTotal(line) - (applied.get(line.id) ?? 0)))
      .map((price, unitIndex) => ({ id: line.id, price, unitIndex })))
    .sort((left, right) => left.price - right.price || left.id.localeCompare(right.id) || left.unitIndex - right.unitIndex);
  const groupSize = config.buyQuantity + config.getQuantity;
  const rewardUnits = Math.floor(units.length / groupSize) * config.getQuantity;
  const result: Record<string, number> = {};
  for (const unit of units.slice(0, rewardUnits)) {
    const discount = roundedBasisPoints(unit.price, config.rewardBasisPoints);
    result[unit.id] = (result[unit.id] ?? 0) + discount;
  }
  return result;
}

function evaluateStrategy(
  candidate: PromotionCandidate,
  lines: readonly PromotionCartLine[],
  eligible: readonly PromotionCartLine[],
  applied: ReadonlyMap<string, number>,
): { allocations: Record<string, number>; unsupported?: string } {
  const remaining = remainingLineTotals(lines, eligible, applied);
  const eligibleSubtotal = remaining.reduce((sum, line) => sum + line.amountPaise, 0);
  if (eligibleSubtotal <= 0) return { allocations: {} };
  const config = candidate.config;
  let amount = 0;
  switch (config.strategy) {
    case "PERCENTAGE_OFF":
      amount = roundedBasisPoints(eligibleSubtotal, config.discountBasisPoints);
      return { allocations: boundedDiscount(lines, eligible, applied, amount, config.maxDiscountPaise) };
    case "FIXED_AMOUNT_OFF":
      return { allocations: boundedDiscount(lines, eligible, applied, config.amountPaise) };
    case "CART_THRESHOLD": {
      if (totalRemaining(lines, applied) < config.thresholdPaise) return { allocations: {} };
      amount = discountedAmount(eligibleSubtotal, config.discountType, config.value, config.maxDiscountPaise);
      return { allocations: boundedDiscount(lines, eligible, applied, amount, config.maxDiscountPaise) };
    }
    case "QUANTITY_TIER": {
      const quantity = eligible.reduce((sum, line) => sum + line.quantity, 0);
      const tier = chooseTier(config, quantity);
      if (!tier) return { allocations: {} };
      amount = discountedAmount(eligibleSubtotal, tier.discountType, tier.value, tier.maxDiscountPaise);
      return { allocations: boundedDiscount(lines, eligible, applied, amount, tier.maxDiscountPaise) };
    }
    case "BUY_X_GET_Y":
      return { allocations: buyXGetYAllocation(config, lines, eligible, applied) };
    case "BUNDLE": {
      const distinctProducts = new Set(eligible.map((line) => line.productId));
      if (distinctProducts.size < config.minimumDistinctProducts) return { allocations: {} };
      amount = roundedBasisPoints(eligibleSubtotal, config.discountBasisPoints);
      return { allocations: boundedDiscount(lines, eligible, applied, amount) };
    }
    case "FREE_SHIPPING":
      return { allocations: {}, unsupported: "Shipping discount requires a configured, authoritative shipping quote; no amount was applied." };
  }
}

function candidateStatus(candidate: PromotionCandidate, currency: string, context: PromotionContext): string | null {
  const now = (context.now ?? new Date()).getTime();
  if (candidate.currency !== currency) return "Promotion currency does not match this cart.";
  if (!context.ignoreLifecycle && candidate.status && candidate.status !== "ACTIVE") return "Promotion is not active.";
  if (!context.ignoreLifecycle && candidate.campaignStatus && candidate.campaignStatus !== "ACTIVE") return "Campaign is not active.";
  const starts = Math.max(candidate.startsAt?.getTime() ?? -Infinity, candidate.campaignStartsAt?.getTime() ?? -Infinity);
  const ends = Math.min(candidate.endsAt?.getTime() ?? Infinity, candidate.campaignEndsAt?.getTime() ?? Infinity);
  if (now < starts) return "Promotion has not started.";
  if (now >= ends) return "Promotion has ended.";
  if (candidate.eligibility.firstOrderOnly) return "First-order eligibility is unavailable until trusted order history is integrated.";
  if (candidate.eligibility.requireAuthenticatedCustomer && !context.userId) return "Sign in is required for this promotion.";
  if (!customerMatches(candidate.targets, context.userId)) return "Customer is not eligible.";
  return null;
}

function eligibleLinesFor(candidate: PromotionCandidate, lines: readonly PromotionCartLine[]): PromotionCartLine[] {
  return lines.filter((line) => line.currency === candidate.currency && lineMatchesTargets(line, candidate.targets));
}

function scoreCandidate(
  candidate: PromotionCandidate,
  lines: readonly PromotionCartLine[],
  currency: string,
  context: PromotionContext,
): { eligibleLines: PromotionCartLine[]; allocations: Record<string, number>; reason: string; unsupported?: string } {
  const status = candidateStatus(candidate, currency, context);
  if (status) return { eligibleLines: [], allocations: {}, reason: status };
  const eligible = eligibleLinesFor(candidate, lines);
  if (!eligible.length) return { eligibleLines: [], allocations: {}, reason: "No cart items match this promotion." };
  const currentSubtotal = totalRemaining(lines, new Map());
  if (candidate.eligibility.minimumCartSubtotalPaise != null && currentSubtotal < candidate.eligibility.minimumCartSubtotalPaise) {
    return { eligibleLines: eligible, allocations: {}, reason: "Minimum cart amount is not met." };
  }
  if (candidate.eligibility.minimumItemQuantity != null && eligible.reduce((sum, line) => sum + line.quantity, 0) < candidate.eligibility.minimumItemQuantity) {
    return { eligibleLines: eligible, allocations: {}, reason: "Minimum eligible quantity is not met." };
  }
  const evaluated = evaluateStrategy(candidate, lines, eligible, new Map());
  if (evaluated.unsupported) return { eligibleLines: eligible, allocations: {}, reason: evaluated.unsupported, unsupported: evaluated.unsupported };
  const discount = sumAllocations(evaluated.allocations);
  return {
    eligibleLines: eligible,
    allocations: evaluated.allocations,
    reason: discount > 0 ? "Eligible." : "Promotion requirements are not met by this cart.",
  };
}

function asAllocation(candidate: PromotionCandidate, allocations: Record<string, number>): PromotionAllocation {
  return {
    promotionId: candidate.id,
    promotionName: candidate.name,
    couponId: candidate.couponId ?? null,
    amountPaise: sumAllocations(allocations),
    lineAllocations: allocations,
    stackable: candidate.stackable,
    priority: candidate.priority,
  };
}

/**
 * Pure promotion allocator. It consumes the server-priced cart only; prices,
 * eligibility, capacity, and customer identity are never read from client input.
 */
export function evaluatePromotionCart(input: {
  candidates: readonly PromotionCandidate[];
  lines: readonly PromotionCartLine[];
  currency: string;
  context: PromotionContext;
}): PromotionEvaluation {
  const evaluatedPromotions: PromotionEvaluation["evaluatedPromotions"] = [];
  const unsupported: PromotionEvaluation["unsupported"] = [];
  const ranked = [...input.candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const baseScores = ranked.map((candidate) => {
    const scored = scoreCandidate(candidate, input.lines, input.currency, input.context);
    if (scored.unsupported) unsupported.push({ promotionId: candidate.id, strategy: candidate.strategy, reason: scored.unsupported });
    return { candidate, ...scored };
  });
  const applicable = baseScores.filter((score) => sumAllocations(score.allocations) > 0);
  const chosen = applicable.some((score) => !score.candidate.stackable)
    ? [
        [...applicable].sort((a, b) =>
          sumAllocations(b.allocations) - sumAllocations(a.allocations) ||
          b.candidate.priority - a.candidate.priority ||
          a.candidate.id.localeCompare(b.candidate.id),
        )[0]!,
      ]
    : applicable;

  const accumulated = new Map<string, number>();
  const allocations: PromotionAllocation[] = [];
  for (const score of chosen) {
    const live = evaluateStrategy(score.candidate, input.lines, score.eligibleLines, accumulated);
    const lineAllocations = live.allocations;
    const amountPaise = sumAllocations(lineAllocations);
    if (amountPaise > 0) {
      allocations.push(asAllocation(score.candidate, lineAllocations));
      for (const [lineId, amount] of Object.entries(lineAllocations)) {
        const available = input.lines.find((line) => line.id === lineId);
        if (available) accumulated.set(lineId, Math.min(lineTotal(available), (accumulated.get(lineId) ?? 0) + amount));
      }
    }
  }

  for (const score of baseScores) {
    const applied = allocations.find((allocation) => allocation.promotionId === score.candidate.id);
    evaluatedPromotions.push({
      promotionId: score.candidate.id,
      name: score.candidate.name,
      eligible: Boolean(applied),
      reason: applied ? "Eligible." : score.reason,
      discountPaise: applied?.amountPaise ?? 0,
    });
  }
  return {
    allocations,
    totalDiscountPaise: allocations.reduce((sum, allocation) => sum + allocation.amountPaise, 0),
    evaluatedPromotions,
    unsupported,
  };
}

/** Keeps monetary aggregates exact and mirrors the allocations onto cart lines. */
export function applyPromotionEvaluationToCart<T extends {
  items: Array<{ id: string; quantity: number; unitPricePaise: number | null; lineSubtotalPaise: number | null; lineDiscountPaise: number }>;
  totals: { listSubtotalPaise: number; productDiscountPaise: number; cartDiscountPaise: number; subtotalPaise: number; estimatedTaxPaise: number; deliveryEstimatePaise: number | null; totalPaise: number; currency: string };
}>(cart: T, evaluation: PromotionEvaluation): T {
  const byLine = new Map<string, number>();
  for (const allocation of evaluation.allocations) {
    for (const [lineId, amount] of Object.entries(allocation.lineAllocations)) {
      byLine.set(lineId, (byLine.get(lineId) ?? 0) + amount);
    }
  }
  const items = cart.items.map((item) => {
    const amount = Math.min(item.lineSubtotalPaise ?? 0, byLine.get(item.id) ?? 0);
    return {
      ...item,
      lineSubtotalPaise: item.lineSubtotalPaise === null ? null : Math.max(0, item.lineSubtotalPaise - amount),
      lineDiscountPaise: item.lineDiscountPaise + amount,
    };
  });
  const appliedDiscount = items.reduce((sum, item) => {
    const originalLine = cart.items.find((line) => line.id === item.id);
    return sum + Math.max(0, (originalLine?.lineSubtotalPaise ?? 0) - (item.lineSubtotalPaise ?? 0));
  }, 0);
  return {
    ...cart,
    items,
    totals: {
      ...cart.totals,
      cartDiscountPaise: cart.totals.cartDiscountPaise + appliedDiscount,
      subtotalPaise: Math.max(0, cart.totals.subtotalPaise - appliedDiscount),
      totalPaise: Math.max(0, cart.totals.totalPaise - appliedDiscount),
    },
  };
}
