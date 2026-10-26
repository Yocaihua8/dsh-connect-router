// Adapted from dingminhua/dsh-connect-workbuddy @ 3b558326a962aa2cfa57ff558b452f7635b447ac.
// MIT; Copyright (c) 2026 LaoDing. See THIRD_PARTY_NOTICES.md.

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
    refreshExpiresAtMs?: number;
    domain: string;
    uid: string;
    enterpriseId?: string;
    nickname?: string;
    /**
     * The account's DISPLAY name, when the app publishes one (issue #124).
     *
     * For an enterprise member `nickname` is the LOGIN ALIAS, not a person's
     * name — a card showing it looks like it is managing somebody else's
     * account. The official client prefers this field, then the enterprise user
     * name, and only then the alias.
     *
     * Read from the desktop auth document when present. It is NOT always there
     * (the app writes only what it has), which is why the read order has three
     * steps rather than two.
     */
    displayName?: string;
    /** The enterprise-side user name (`enterpriseUserName`), when published. */
    enterpriseUserName?: string;
    uin?: string;
    /** Which auth file this came from; refreshes are always `dsh`. */
    source: 'desktop' | 'dsh';
    /** Absolute path of the auth file this credential was read from. */
    filePath: string;
    /**
     * Epoch ms the upstream last issued this token (`auth.lastRefreshTime`).
     *
     * This is the ONLY trustworthy freshness signal. `expiresAtMs` cannot be
     * used for ranking: when the upstream revokes a token it leaves the stored
     * `expiresAt` untouched, so a long-dead backup can claim a LATER expiry than
     * the live sign-in (observed on a real machine — a 2026-07-08 backup claimed
     * 2027-07-06 while the live file expired 2026-11-14, and only the live file
     * was accepted). Undefined when the document omits the field.
     */
    lastRefreshAtMs?: number;
}
