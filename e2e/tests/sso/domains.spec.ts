import { test, expect } from "../../fixtures";
import { createWorkspace } from "../../support/api";
import { makeOrg } from "../../support/org";
import { MAIN_PORT, modeWorkers } from "../../support/hosts";
import {
  addDomain, client, codeOf, dns, newOrg, putPolicy, recordName, removeDomain, security, uniqueDomain, userOn, verifyDomain,
  verifyDomainRaw, type DomainRow, type Security,
} from "../../support/sso";

// Verified domains: an owner or admin claims a domain, the app hands back a TXT
// record to publish, and Verify looks for it over DNS-over-HTTPS (the specs'
// resolver is e2e/support/mock-services.mjs). One organisation at a time can hold
// a verified domain. See worker/src/domains.ts and docs/SSO.md.

const MAIN = `http://127.0.0.1:${MAIN_PORT}`;

test.describe("personal: refuses all of it", () => {
  test.use({ baseURL: modeWorkers.personal.baseURL });

  test("every route answers 403 team_spaces_disabled, to the owner of the only workspace there is", async ({ account, request }) => {
    void account;
    const me = (await (await request.get("/api/auth/me")).json()).user.id as string;
    const gone = { status: 403, code: "team_spaces_disabled" };
    expect(await codeOf(await security(request, me))).toEqual(gone);
    expect(await codeOf(await addDomain(request, me, "example.com"))).toEqual(gone);
    expect(await codeOf(await verifyDomainRaw(request, me, "x"))).toEqual(gone);
    expect(await codeOf(await removeDomain(request, me, "x"))).toEqual(gone);
    expect(await codeOf(await putPolicy(request, me, { auto_join: false }))).toEqual(gone);
    expect(await codeOf(await request.put(`/api/workspaces/${me}/sso`, { data: {} }))).toEqual(gone);
    expect(await codeOf(await request.post(`/api/workspaces/${me}/sso/test`))).toEqual(gone);
    expect(await codeOf(await request.post(`/api/workspaces/${me}/sso/enable`, { data: { enabled: true } }))).toEqual(gone);
    expect(await codeOf(await request.post(`/api/workspaces/${me}/sso/enforce`, { data: { enforced: true } }))).toEqual(gone);
    expect(await codeOf(await request.delete(`/api/workspaces/${me}/sso`))).toEqual(gone);
    expect(await codeOf(await request.post(`/api/workspaces/${me}/join`))).toEqual(gone);
    expect(await codeOf(await request.get("/api/join-offers"))).toEqual(gone);
    expect(await codeOf(await request.post("/api/auth/sso/start", { data: { email: "a@b.example" } }))).toEqual(gone);
  });
});

for (const [name, baseURL] of [
  ["multitenant", modeWorkers.multitenant.baseURL],
  ["unset", MAIN],
] as const) {
  test.describe(`${name}: adding and verifying a domain`, () => {
    test.use({ baseURL });

    test("adding a domain hands back a TXT record to publish, with a random token", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const a = uniqueDomain();
      const b = uniqueDomain();
      const res = await addDomain(request, ws.id, a);
      expect(res.status()).toBe(201);
      const first = (await res.json()) as DomainRow;
      expect(first).toMatchObject({ domain: a, status: "pending", verified_at: null });
      expect(first.record).toMatchObject({ type: "TXT", name: `_mindmaps-verify.${a}` });
      expect(first.record!.value).toMatch(/^mindmaps-verify=[A-Za-z0-9_-]{32,}$/);

      const second = (await (await addDomain(request, ws.id, b)).json()) as DomainRow;
      expect(second.record!.value).not.toBe(first.record!.value);
      const listed = (await (await security(request, ws.id)).json()) as Security;
      expect(listed.domains.map((d) => d.domain).sort()).toEqual([a, b].sort());
    });

    test("a domain is normalised, and nonsense is refused", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const d = uniqueDomain();
      const res = await addDomain(request, ws.id, `  ${d.toUpperCase()}. `);
      expect(res.status()).toBe(201);
      expect(((await res.json()) as DomainRow).domain).toBe(d);

      for (const bad of ["", "   ", "localhost", "nodot", "a b.example.com", "http://example.com", "example.com/path", "user@example.com",
        "-bad.example.com", "bad-.example.com", "exa_mple.com", "1.2.3.4", "[::1]", ".example.com", "a..b.com", "x".repeat(64) + ".com",
        `${"a.".repeat(130)}com`, 42, null, undefined, {}]) {
        expect(await codeOf(await addDomain(request, ws.id, bad)), `domain ${JSON.stringify(bad)}`).toEqual({ status: 400, code: "invalid_domain" });
      }
    });

    test("the same domain twice in one organisation is refused", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const d = uniqueDomain();
      expect((await addDomain(request, ws.id, d)).status()).toBe(201);
      expect(await codeOf(await addDomain(request, ws.id, d))).toEqual({ status: 409, code: "domain_exists" });
    });

    test("Verify finds the record over DNS-over-HTTPS and the domain becomes verified", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const d = uniqueDomain();
      const added = (await (await addDomain(request, ws.id, d)).json()) as DomainRow;
      await dns.setTxt(added.record!.name, "v=spf1 -all", added.record!.value);

      const res = await verifyDomainRaw(request, ws.id, added.id);
      expect(res.status(), await res.text()).toBe(200);
      const body = (await res.json()) as { ok: boolean; domain: DomainRow };
      expect(body.ok).toBe(true);
      expect(body.domain).toMatchObject({ id: added.id, domain: d, status: "verified" });
      expect(body.domain.verified_at).toBeGreaterThan(0);

      // it asked the right question, the way Cloudflare's JSON API wants it
      const asked = await dns.queries(recordName(d));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]).toMatchObject({ type: "TXT", accept: expect.stringContaining("application/dns-json") });

      // verifying again changes nothing
      const again = await verifyDomainRaw(request, ws.id, added.id);
      expect(again.status()).toBe(200);
      expect(((await again.json()) as { domain: DomainRow }).domain.verified_at).toBe(body.domain.verified_at);
      const sec = (await (await security(request, ws.id)).json()) as Security;
      expect(sec.domains[0]).toMatchObject({ status: "verified", record: null });
    });

    test("Verify fails, with the record to publish, when there is none or it is wrong", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const d = uniqueDomain();
      const added = (await (await addDomain(request, ws.id, d)).json()) as DomainRow;

      let res = await verifyDomainRaw(request, ws.id, added.id);
      expect(await codeOf(res)).toEqual({ status: 422, code: "dns_record_not_found" });
      expect(((await res.json()) as { error: string }).error).toContain(added.record!.value);

      await dns.setTxt(added.record!.name, "mindmaps-verify=somebody-elses-token", "unrelated");
      expect(await codeOf(await verifyDomainRaw(request, ws.id, added.id))).toEqual({ status: 422, code: "dns_record_not_found" });
      // a record that merely contains the token is not the record
      await dns.setTxt(added.record!.name, `x ${added.record!.value}`, `${added.record!.value}x`);
      expect(await codeOf(await verifyDomainRaw(request, ws.id, added.id))).toEqual({ status: 422, code: "dns_record_not_found" });

      const sec = (await (await security(request, ws.id)).json()) as Security;
      expect(sec.domains[0]!.status).toBe("pending");
    });

    test("a lookup that fails is not a verdict: 502, and the domain stays pending", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const d = uniqueDomain();
      const added = (await (await addDomain(request, ws.id, d)).json()) as DomainRow;
      await dns.setTxt(added.record!.name, added.record!.value);
      for (const mode of ["servfail", "http500"] as const) {
        await dns.fail(added.record!.name, mode);
        expect(await codeOf(await verifyDomainRaw(request, ws.id, added.id)), mode).toEqual({ status: 502, code: "dns_lookup_failed" });
      }
      await dns.fail(added.record!.name, null);
      expect((await verifyDomainRaw(request, ws.id, added.id)).status()).toBe(200);
    });

    test("only one organisation holds a verified domain; removing it frees it", async ({ account, request, makePerson }) => {
      void account;
      const other = await makePerson("other-owner");
      const mine = await createWorkspace(request, "Mine");
      const theirs = await createWorkspace(other.request, "Theirs");
      const d = uniqueDomain();

      // both add it before either verifies: that is allowed, only a verified claim is exclusive
      const a = (await (await addDomain(request, mine.id, d)).json()) as DomainRow;
      const b = (await (await addDomain(other.request, theirs.id, d)).json()) as DomainRow;
      await dns.setTxt(a.record!.name, a.record!.value, b.record!.value);

      expect((await verifyDomainRaw(request, mine.id, a.id)).status()).toBe(200);
      expect(await codeOf(await verifyDomainRaw(other.request, theirs.id, b.id))).toEqual({ status: 409, code: "domain_taken" });
      // and a late arrival cannot even add it
      const third = await makePerson("third");
      const thirdWs = await createWorkspace(third.request, "Third");
      expect(await codeOf(await addDomain(third.request, thirdWs.id, d))).toEqual({ status: 409, code: "domain_taken" });

      // case and a trailing dot do not make it a different domain
      expect(await codeOf(await addDomain(third.request, thirdWs.id, `${d.toUpperCase()}.`))).toEqual({ status: 409, code: "domain_taken" });

      // the holder lets go; the other can now verify
      expect((await removeDomain(request, mine.id, a.id)).status()).toBe(200);
      expect((await verifyDomainRaw(other.request, theirs.id, b.id)).status()).toBe(200);
      expect((await addDomain(request, mine.id, d).then((r) => r.status()))).toBe(409);
    });

    test("two organisations verifying the same domain at once: exactly one wins", async ({ account, request, makePerson }) => {
      void account;
      const other = await makePerson("racer");
      const w1 = await createWorkspace(request, "One");
      const w2 = await createWorkspace(other.request, "Two");
      const d = uniqueDomain();
      const a = (await (await addDomain(request, w1.id, d)).json()) as DomainRow;
      const b = (await (await addDomain(other.request, w2.id, d)).json()) as DomainRow;
      await dns.setTxt(a.record!.name, a.record!.value, b.record!.value);
      const results = await Promise.all([verifyDomainRaw(request, w1.id, a.id), verifyDomainRaw(other.request, w2.id, b.id)]);
      expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
    });

    test("removing is soft: the domain disappears from the list and can be added again", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Acme");
      const d = uniqueDomain();
      const row = await verifyDomain(request, ws.id, d);
      expect((await removeDomain(request, ws.id, row.id)).status()).toBe(200);
      expect(((await (await security(request, ws.id)).json()) as Security).domains).toEqual([]);
      expect(await codeOf(await removeDomain(request, ws.id, row.id))).toEqual({ status: 404, code: "not_found" });
      expect(await codeOf(await verifyDomainRaw(request, ws.id, row.id))).toEqual({ status: 404, code: "not_found" });

      const again = await addDomain(request, ws.id, d);
      expect(again.status()).toBe(201);
      const fresh = (await again.json()) as DomainRow;
      expect(fresh.id).not.toBe(row.id);
      expect(fresh.record!.value).not.toBe(row.record?.value);
    });

    test("a domain id from another organisation is not found", async ({ account, request, makePerson }) => {
      void account;
      const other = await makePerson("other");
      const mine = await createWorkspace(request, "Mine");
      const theirs = await createWorkspace(other.request, "Theirs");
      const row = (await (await addDomain(other.request, theirs.id, uniqueDomain())).json()) as DomainRow;
      expect(await codeOf(await verifyDomainRaw(request, mine.id, row.id))).toEqual({ status: 404, code: "not_found" });
      expect(await codeOf(await removeDomain(request, mine.id, row.id))).toEqual({ status: 404, code: "not_found" });
      expect(((await (await security(other.request, theirs.id)).json()) as Security).domains[0]!.status).toBe("pending");
    });
  });

  test.describe(`${name}: who may manage domains`, () => {
    test.use({ baseURL });

    test("owner and admin may; editor, viewer, outsider and signed-out may not", async ({ account, request, makePerson }) => {
      void account;
      const org = await makeOrg(request, makePerson, "Team");
      const outsider = await makePerson("outsider");
      const d = uniqueDomain();
      const row = (await (await addDomain(request, org.ws.id, d)).json()) as DomainRow;

      // the admin can see it all, and verify and remove
      const seen = (await (await security(org.admin.request, org.ws.id)).json()) as Security;
      expect(seen.domains[0]!.record!.value).toBe(row.record!.value);
      await dns.setTxt(row.record!.name, row.record!.value);
      expect((await verifyDomainRaw(org.admin.request, org.ws.id, row.id)).status()).toBe(200);
      const second = (await (await addDomain(org.admin.request, org.ws.id, uniqueDomain())).json()) as DomainRow;
      expect((await removeDomain(org.admin.request, org.ws.id, second.id)).status()).toBe(200);

      for (const who of [org.editor, org.viewer]) {
        expect(await codeOf(await security(who.request, org.ws.id))).toEqual({ status: 403, code: "forbidden" });
        expect(await codeOf(await addDomain(who.request, org.ws.id, uniqueDomain()))).toEqual({ status: 403, code: "forbidden" });
        expect(await codeOf(await verifyDomainRaw(who.request, org.ws.id, row.id))).toEqual({ status: 403, code: "forbidden" });
        expect(await codeOf(await removeDomain(who.request, org.ws.id, row.id))).toEqual({ status: 403, code: "forbidden" });
      }
      // a stranger learns nothing, not even that the workspace exists
      expect(await codeOf(await security(outsider.request, org.ws.id))).toEqual({ status: 404, code: "not_found" });
      expect(await codeOf(await addDomain(outsider.request, org.ws.id, uniqueDomain()))).toEqual({ status: 404, code: "not_found" });
      expect(await codeOf(await removeDomain(outsider.request, org.ws.id, row.id))).toEqual({ status: 404, code: "not_found" });
      expect(await codeOf(await security(outsider.request, "no-such-workspace"))).toEqual({ status: 404, code: "not_found" });

      const anon = await client(baseURL);
      expect((await security(anon, org.ws.id)).status()).toBe(401);
      await anon.dispose();

      // nothing the refused callers did changed it
      expect(((await (await security(request, org.ws.id)).json()) as Security).domains.map((x) => x.id)).toEqual([row.id]);
    });

    test("a personal workspace has no domains", async ({ account, request }) => {
      void account;
      const me = (await (await request.get("/api/auth/me")).json()).user.id as string;
      expect(await codeOf(await security(request, me))).toEqual({ status: 404, code: "not_an_organisation" });
      expect(await codeOf(await addDomain(request, me, uniqueDomain()))).toEqual({ status: 404, code: "not_an_organisation" });
    });

    test("a closed organisation cannot be managed", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Winding down");
      expect((await request.post(`/api/workspaces/${ws.id}/close`)).status()).toBe(200);
      expect(await codeOf(await addDomain(request, ws.id, uniqueDomain()))).toEqual({ status: 404, code: "not_found" });
    });
  });
}

test.describe("multitenant: the domain list and what it shows", () => {
  test.use({ baseURL: modeWorkers.multitenant.baseURL });

  test("security shows the defaults for an organisation that has set nothing", async ({ account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Fresh");
    const sec = (await (await security(request, ws.id)).json()) as Security;
    expect(sec).toMatchObject({
      workspace_id: ws.id,
      domains: [],
      policy: { auto_join: false, default_role: "viewer", restrict_invites: false, enforce_sso: false },
      sso: { status: "none", issuer: null, client_id: null, has_secret: false, tested_at: null },
    });
    expect(sec.sso.redirect_uri).toBe(`${modeWorkers.multitenant.baseURL}/api/auth/sso/callback`);
  });

  test("a domain on one organisation does not appear on another's", async ({ personOn }) => {
    const a = await newOrg(personOn, { name: "A" });
    const b = await newOrg(personOn, { name: "B" });
    const sa = (await (await security(a.owner.request, a.ws)).json()) as Security;
    const sb = (await (await security(b.owner.request, b.ws)).json()) as Security;
    expect(sa.domains.map((d) => d.domain)).toEqual([a.domain]);
    expect(sb.domains.map((d) => d.domain)).toEqual([b.domain]);
    expect(userOn(a.domain).email.endsWith(`@${a.domain}`)).toBe(true);
  });
});
