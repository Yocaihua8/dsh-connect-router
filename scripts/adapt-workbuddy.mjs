import { readFile, writeFile } from "node:fs/promises";
const base = "src/host/workbuddy/vendor/";
let s = await readFile(base + "upstream.ts", "utf8");
// Cancellation is propagated on all interactive JSON requests; no silent fallback after abort.
s = s.replace(
  /async (refreshToken|fetchCheckinStatus|fetchBenefits|claimDailyCheckin|fetchEnterpriseCredits|fetchCredits)\(credential: WorkBuddyCredential\)/gu,
  "async $1(credential: WorkBuddyCredential, signal?: AbortSignal)",
);
s = s.replaceAll(
  "signal: AbortSignal.timeout(JSON_TIMEOUT_MS)",
  "signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)])",
);
s = s.replace(
  "const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS);",
  "const timeout = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]);",
);
s = s.replace(
  "kind: WorkBuddyBenefit['kind']): Promise<void>",
  "kind: WorkBuddyBenefit['kind'], signal?: AbortSignal): Promise<void>",
);
s = s.replace(
  "path: string): Promise<WorkBuddyBenefit>",
  "path: string, signal?: AbortSignal): Promise<WorkBuddyBenefit>",
);
s = s.replace(
  "return await this.readBenefitStatus(kind, credential, path);",
  "return await this.readBenefitStatus(kind, credential, path, signal);",
);
s = s.replace(
  "catch {\n                return undefined;\n            }",
  "catch (error) {\n                throw error;\n            }",
);
s = s.replace(
  "this.fetchEnterpriseCredits(credential)",
  "this.fetchEnterpriseCredits(credential, signal)",
);
s = s.replace(
  "} catch (error: unknown) {\n            // Three failures",
  "} catch (error: unknown) {\n            signal?.throwIfAborted();\n            // Three failures",
);
s = s.replace(
  "const parsed = Date.parse(raw.replace(' ', 'T'));",
  "const normalized=raw.replace(' ', 'T');\n            const parsed = Date.parse(/(?:Z|[+-]\\d{2}:?\\d{2})$/u.test(normalized) ? normalized : regionOf(credential.domain)==='cn' ? normalized+'+08:00' : 'invalid');",
);
await writeFile(base + "upstream.ts", s);
let o = await readFile(base + "oauth.ts", "utf8");
o = o.replace(
  "options?: { base?: string, fetchImpl?: typeof fetch }",
  "options?: { base?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }",
);
o = o.replace(
  "options?: { fetchImpl?: typeof fetch }",
  "options?: { fetchImpl?: typeof fetch, signal?: AbortSignal }",
);
o = o.replaceAll(
  "signal: AbortSignal.timeout(30_000)",
  "signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(30_000)])",
);
// collectAccount has no options closure: pass cancellation explicitly.
o = o.replace(
  "collectAccount(session, accessToken, data, doFetch)",
  "collectAccount(session, accessToken, data, doFetch, options?.signal)",
);
o = o.replace(
  "doFetch: typeof fetch,\n):",
  "doFetch: typeof fetch,\n  signal?: AbortSignal,\n):",
);
const start = o.indexOf("async function collectAccount("),
  end = o.indexOf("/** Region a finished login", start);
o =
  o.slice(0, start) +
  o
    .slice(start, end)
    .replaceAll("options?.signal", "signal")
    .replaceAll("options.signal", "signal") +
  o.slice(end);
o = o.replace(
  "const base = normalizeBase(oauthBillingBase(region, options?.base))",
  "const base = normalizeBase(oauthBillingBase(region, options?.base))\n  if (!['https://www.codebuddy.cn', 'https://www.workbuddy.ai', 'https://www.codebuddy.ai'].includes(base)) return {error:'Unsupported OAuth endpoint'}\n  options?.signal?.throwIfAborted()",
);
o = o.replace(
  "const data = envelopeData(document)\n  const state",
  "if (!response.ok || ![0, 200].includes(Number(document['code']))) return {error:'OAuth request rejected'}\n  const data = envelopeData(document)\n  const state",
);
o +=
  "\n/** Router cancellation removes only this process-local authorization attempt. */\nexport function oauthCancel(loginId:string):void { sessions.delete(loginId) }\n";
await writeFile(base + "oauth.ts", o);
