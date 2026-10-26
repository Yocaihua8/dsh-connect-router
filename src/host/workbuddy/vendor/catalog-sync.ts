// Adapted from dingminhua/dsh-connect-workbuddy @ 3b558326a962aa2cfa57ff558b452f7635b447ac.
// MIT; Copyright (c) 2026 LaoDing. See THIRD_PARTY_NOTICES.md.
import type { WorkBuddyUpstreamModel as WorkBuddyModelInfo } from "./upstream.js";
/**
 * The capability fields a saved directory may carry but must never be trusted
 * for, because the live roster is the authority on all of them.
 *
 * `reasoning` is the one issue #114 is about. `creditMultiplier` and
 * `supportsImages` ride along for the same reason: the upstream publishes
 * them, the saved copy is a snapshot of one moment, and a stale multiplier is
 * a wrong PRICE shown to the user.
 *
 * `promos` is NOT in this list — see {@link overlayLiveCapabilities} for why it
 * needs a different rule (it must be able to CLEAR a saved value, which this
 * loop cannot express).
 */
const LIVE_OWNED_FIELDS = ['reasoning', 'creditMultiplier', 'supportsImages'] as const;
/**
 * Overlay the live roster's capabilities onto a saved directory entry.
 *
 * The saved entry contributes IDENTITY (the id, the name the user saw, the
 * context budget) and the live entry contributes CAPABILITY. When the live
 * roster does not know the model at all, the saved entry is returned
 * unchanged — it may be a model the upstream withdrew but the user is still
 * running, and issue #32's rule says such a model must stay offered.
 *
 * `reasoning` is replaced rather than merged: a saved `reasoning` block
 * describes one moment's upstream answer, and merging the two would leave
 * `canDisableThinking` from the stale copy attached to a fresh set of
 * efforts. The user's own `off` choice is NOT part of this — it is stamped
 * later by `withEffectiveOff`, from the saved selection, not from here.
 *
 * The `canDisableThinking` in the LIVE block is the upstream's DECLARATION,
 * and the user's effective choice is stamped over it by `withEffectiveOff`
 * afterwards. So the overlay restores the declaration, and the user's tick
 * still wins.
 *
 * `promos` IS LIVE-OWNED TOO, AND IS REPLACED UNCONDITIONALLY. It cannot use
 * the loop above, because that loop only writes a field the live entry HAS —
 * which would keep a saved promotion forever once the upstream withdrew it.
 * Both directions were observed to be wrong before this rule existed:
 *
 *   - saved WITHOUT `promos`, live WITH them → the live promotions were
 *     dropped entirely, so a model on a night discount drew no badge at all;
 *   - saved WITH old `promos`, live with new ones → the saved ones won, so a
 *     promotion whose hours the upstream had since changed kept advertising
 *     the OLD hours.
 *
 * The card persists `promos` into `lastCatalog` (the settings schema keeps
 * unknown keys), so a user who saved the directory once had their badges
 * frozen at that moment — the exact opposite of what `src/promo.ts` promises
 * ("a badge is a function of the clock, not of the fetch"). The upstream's
 * current answer therefore REPLACES the saved one, including when that answer
 * is "no promotions at all": a badge the upstream no longer publishes must
 * stop being drawn, and a standing entry with no schedule has no absolute
 * window to expire it on its own.
 *
 * The key is DELETED rather than set to `undefined` when the live entry has
 * no promotions, for the same reason `resolveRoster` deletes `busyLevel`: an
 * explicit `undefined` survives `structuredClone` and the settings write
 * path's strict JSON codec rejects the whole save.
 */
export function overlayLiveCapabilities(saved: WorkBuddyModelInfo, live: WorkBuddyModelInfo | undefined): WorkBuddyModelInfo {
    if (live === undefined)
        return saved;
    const overlay: Record<string, unknown> = {};
    for (const field of LIVE_OWNED_FIELDS) {
        const value = (live as unknown as Record<string, unknown>)[field];
        if (value !== undefined)
            overlay[field] = value;
    }
    // `busyLevel` is deliberately NOT overlaid: it is a fact about this minute
    // and it never reaches the saved directory anyway (`src/busy.ts`).
    const livePromos = (live as {
        promos?: readonly unknown[];
    }).promos;
    const savedPromos = (saved as {
        promos?: readonly unknown[];
    }).promos;
    // Any asymmetry is worth acting on, in BOTH directions: live-with-promos
    // must win, and live-without must clear a saved copy.
    const promosDiffer = livePromos !== savedPromos
        && (livePromos !== undefined || savedPromos !== undefined);
    if (Object.keys(overlay).length === 0 && !promosDiffer)
        return saved;
    if (livePromos !== undefined) {
        overlay['promos'] = livePromos;
        return { ...saved, ...overlay } as WorkBuddyModelInfo;
    }
    // The live entry has none: drop the saved copy BY KEY.
    const { promos: _stalePromos, ...rest } = saved as WorkBuddyModelInfo & {
        promos?: readonly unknown[];
    };
    return { ...rest, ...overlay } as WorkBuddyModelInfo;
}
/**
 * The roster the runtime and the card should serve: the live roster, with the
 * saved directory's own models kept when the upstream no longer lists them.
 *
 * ORDER matters for the card (it lists the roster as given) and is
 * preserved from the live roster, with the kept-but-withdrawn models
 * appended. The live roster wins on every shared id.
 *
 * @param saved The saved directory (may be empty).
 * @param live The live upstream roster (may be empty when the upstream is
 *   unreachable — then this answers the saved directory alone).
 */
export function mergeRoster(saved: readonly WorkBuddyModelInfo[], live: readonly WorkBuddyModelInfo[]): readonly WorkBuddyModelInfo[] {
    const liveById = new Map(live.map(model => [model.id, model]));
    const savedById = new Map(saved.map(model => [model.id, model]));
    // The live roster first, in ITS order: it is what the upstream currently
    // offers, and the card lists the roster as it stands.
    const merged: WorkBuddyModelInfo[] = [];
    const seen = new Set<string>();
    for (const model of live) {
        if (seen.has(model.id))
            continue;
        seen.add(model.id);
        const savedEntry = savedById.get(model.id);
        merged.push(savedEntry === undefined ? model : overlayLiveCapabilities(savedEntry, model));
    }
    // Then the saved models the upstream no longer lists. They stay, because the
    // user may still be running one (issue #32: a refresh must never withdraw a
    // model the user is on), and the live roster cannot supply their
    // capabilities either — the saved entry is all that is left of them.
    for (const model of saved) {
        if (seen.has(model.id))
            continue;
        seen.add(model.id);
        merged.push(model);
    }
    return merged;
}