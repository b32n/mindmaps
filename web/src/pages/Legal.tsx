/**
 * /privacy and /terms.
 *
 * Plain-English pages that describe what this software does with data, written
 * against the code (worker/src, worker/migrations). They are public: you have to
 * be able to read them before you sign up.
 *
 * Who is speaking depends on the mode (docs/MODES.md):
 *
 *   multitenant   the hosted service. The operator is the Mindmaps project, and
 *                 the decisions that need a lawyer (governing law, liability,
 *                 minimum age, effective date...) are the visible placeholders in
 *                 ../legal/config.ts.
 *   personal/org  someone's own install. The operator is whoever runs it, which
 *                 the pages say plainly, naming them only if they set
 *                 OPERATOR_NAME / OPERATOR_CONTACT. The text is a template they
 *                 should review and replace, and nothing legal is decided for
 *                 them.
 *
 * If the mode cannot be read the pages use the self-hosted wording: the safe
 * mistake is to claim less, not to speak for the hosted service.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { legal, type LegalInfo } from "../api";
import { useAuth } from "../AuthContext";
import {
  HOSTED_URL,
  PLACEHOLDERS,
  REPO_URL,
  RETENTION,
  SECURITY_URL,
  placeholderId,
  type PlaceholderKey,
} from "../legal/config";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** "Privacy · Terms", for the sign-in cards and the app rail. */
export function LegalLinks({ className = "legal-links" }: { className?: string }) {
  return (
    <nav className={className} aria-label="Legal">
      <Link to="/privacy">Privacy</Link>
      <span aria-hidden="true">·</span>
      <Link to="/terms">Terms</Link>
    </nav>
  );
}

/** A decision nobody has made yet, shown as such. Once it has a value in config.ts the value shows instead. */
function Placeholder({ k }: { k: PlaceholderKey }) {
  const spec = PLACEHOLDERS[k];
  if (spec.value !== null) return <>{spec.value}</>;
  return (
    <mark className="legal-placeholder" data-placeholder={placeholderId(k)}>
      [{spec.label}: to be decided]
    </mark>
  );
}

interface Ctx {
  /** the hosted service, as opposed to someone's own install */
  hosted: boolean;
  /** the name to use for whoever is responsible: "we" is avoided on self-hosted pages */
  who: string;
  operator: LegalInfo["operator"];
}

function useLegalInfo(): { ctx: Ctx | null } {
  const [info, setInfo] = useState<LegalInfo | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    legal.info().then(
      (i) => live && setInfo(i),
      () => live && setInfo("failed"),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!info) return { ctx: null };
  const operator = info === "failed" ? { name: null, contact: null } : info.operator;
  const hosted = info !== "failed" && info.mode === "multitenant";
  const who = hosted ? "the Mindmaps project" : (operator.name ?? "the operator of this instance");
  return { ctx: { hosted, who, operator } };
}

/** An email address becomes a mailto link, an https URL a link, anything else stays text. */
function ContactValue({ value }: { value: string }) {
  if (/^https:\/\//i.test(value))
    return (
      <a href={value} rel="noreferrer noopener">
        {value}
      </a>
    );
  return <a href={`mailto:${value}`}>{value}</a>;
}

function Contact({ ctx }: { ctx: Ctx }) {
  if (ctx.hosted)
    return (
      <>
        {ctx.operator.contact ? (
          <ContactValue value={ctx.operator.contact} />
        ) : (
          <Placeholder k="privacyContact" />
        )}
        . To report a security problem, use the private form described in{" "}
        <a href={SECURITY_URL} rel="noreferrer noopener">
          SECURITY.md
        </a>
        .
      </>
    );
  return ctx.operator.contact ? (
    <ContactValue value={ctx.operator.contact} />
  ) : (
    <>
      the operator of this instance. They have not published a contact address here, so ask whoever gave you access
    </>
  );
}

/** The notice at the top that says whose instance this is. */
function WhoRunsThis({ ctx, page }: { ctx: Ctx; page: "privacy policy" | "terms" }) {
  if (ctx.hosted)
    return (
      <div className="legal-note" data-testid="operator-note">
        <p>
          This is the {page} of the hosted service at {HOSTED_URL}, run by the Mindmaps project
          {PLACEHOLDERS.legalEntity.value === null ? (
            <>
              {" "}
              (<Placeholder k="legalEntity" />)
            </>
          ) : (
            <> ({PLACEHOLDERS.legalEntity.value})</>
          )}
          . Mindmaps is also open-source software that anyone can run on their own Cloudflare account; this page
          does not speak for those instances.
        </p>
      </div>
    );
  return (
    <div className="legal-note" data-testid="operator-note">
      <p>
        <strong>This instance is run by {ctx.operator.name ?? "whoever set it up"}, not by the Mindmaps project.</strong>{" "}
        The operator controls the data stored here, and the {page} that applies to you is theirs. Mindmaps is open-source
        software; this page is a template describing what the software does, supplied for the operator to review and
        replace with their own. It is not legal advice and it decides nothing on the operator's behalf.
      </p>
      <p>
        {ctx.operator.name ? <>Operator: {ctx.operator.name}. </> : <>The operator has not named themselves here. </>}
        Contact: <Contact ctx={ctx} />
        .
      </p>
    </div>
  );
}

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  const { user } = useAuth();
  return (
    <div className="legal-page">
      <header className="legal-head">
        <Link to="/" className="auth-brand">
          mindmaps
        </Link>
        <nav aria-label="Legal pages">
          <Link to="/privacy">Privacy policy</Link>
          <Link to="/terms">Terms of service</Link>
          {user ? <Link to="/app">Back to your mindmaps</Link> : <Link to="/login">Sign in</Link>}
        </nav>
      </header>
      <main className="legal-body">
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

function Loading() {
  return (
    <p className="auth-alt" data-testid="legal-loading">
      Loading…
    </p>
  );
}

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section id={id} className="legal-section">
    <h2>{title}</h2>
    {children}
  </section>
);

// ---------------------------------------------------------------------------
// Privacy policy
// ---------------------------------------------------------------------------

export function PrivacyPage() {
  const { ctx } = useLegalInfo();
  return (
    <LegalLayout title="Privacy policy">
      {!ctx ? <Loading /> : <PrivacyBody ctx={ctx} />}
    </LegalLayout>
  );
}

function PrivacyBody({ ctx }: { ctx: Ctx }) {
  const who = ctx.who;
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  return (
    <>
      <p className="legal-meta" data-testid="effective">
        {ctx.hosted ? (
          <>
            Effective: <Placeholder k="effectiveDate" />
          </>
        ) : (
          <>Template text. The operator sets the date it applies from.</>
        )}
      </p>
      <WhoRunsThis ctx={ctx} page="privacy policy" />

      <p>
        Mindmaps is a place to keep mindmaps, cards, documents and files, and to let AI tools you choose read and write
        them. The short version: it stores what you put in it so it can show it back to you, it does not run ads, it does
        not sell data, and it has no tracking or analytics.
      </p>

      <Section id="what-we-store" title="What is stored">
        <ul>
          <li>
            <strong>Your account:</strong> your email address, a display name, and either a password (stored only as a
            salted, slow hash, never the password itself) or, if you sign in with Google, Google's account identifier and
            your profile picture address.
          </li>
          <li>
            <strong>Your content:</strong> mindmaps, cards and their documents, links between cards, sheets, documents,
            decks and pages, and the files and images you upload. Text and structure live in a database; uploaded files,
            images and the contents of sheets, documents, decks and pages live in object storage.
          </li>
          <li>
            <strong>Search data:</strong> to find cards by meaning as well as by words, the text of your cards is turned
            into numeric embeddings and stored in a vector index (and cached in the database). The text is also kept in a
            full-text search index.
          </li>
          <li>
            <strong>Version history:</strong> each time a card, file or artefact changes, a snapshot is kept, with who made
            the change (you, or which connected app acting for you) and when.
          </li>
          <li>
            <strong>Sign-ins and connections:</strong> a record of each browser session (a hash of the cookie, when it was
            made and expires, and the browser's user-agent text) and each connected AI app (an access token and a refresh
            token, stored only as hashes, with the app's name and when it was last used).
          </li>
          <li>
            <strong>What you asked it:</strong> when an AI tool searches your memory, the question is logged against your
            account, with how many results it found, so retrieval can be checked and improved.
          </li>
          <li>
            <strong>Sharing:</strong> workspaces, memberships and invites (including the email address an invite was sent
            to), and share links with a count of how often each has been opened.
          </li>
          <li>
            <strong>Deleted items:</strong> what you delete goes to a trash first (see{" "}
            <a href="#how-long">how long things are kept</a>).
          </li>
        </ul>
        <p>
          Your connection also passes through Cloudflare, which sees technical details such as IP address in the normal
          way a host does (see below). The application itself does not store IP addresses.
        </p>
      </Section>

      <Section id="what-we-do" title="What it is used for">
        <p>
          {Who} uses this data to run the service for you: to show you your content, keep it in sync, search it, let the
          people and apps you authorise read and write it, and keep your account secure. It is not used for advertising,
          not sold, and not shared except as set out below.{" "}
          {ctx.hosted
            ? "Your content is not used to train AI models."
            : "The software does not use your content to train AI models."}
        </p>
        <p>
          There is no analytics, no advertising network, no tracking pixels and no third-party scripts or fonts on these
          pages or in the app.
        </p>
      </Section>

      <Section id="who-else" title="Who else handles it">
        <ul>
          <li>
            <strong>Cloudflare</strong> hosts the service: the Worker that runs it, the database (D1), file storage (R2),
            the search index (Vectorize) and the model that makes embeddings (Workers AI). Your data is stored in and
            processed by Cloudflare on {ctx.hosted ? "the project's" : "the operator's"} account. See Cloudflare's own
            privacy policy for how it handles it.
          </li>
          <li>
            <strong>Google</strong>, only if you choose "Continue with Google" and the instance has it turned on. Google
            tells the instance your name, email address and picture; the instance sends Google nothing about your
            content. Your picture is then loaded from Google's servers when it is shown.
          </li>
          <li>
            <strong>Email.</strong> Where an instance has email turned on (for verifying an address or resetting a
            password), those messages are sent through Cloudflare Email Sending. Nothing else is sent by email.
          </li>
          <li>
            <strong>Anthropic</strong>, only if the operator has configured the optional research-thread feature and you
            use it on a card. The card's brief is sent to Anthropic to run the research. It is off unless an Anthropic key
            is set.
          </li>
          <li>
            <strong>AI tools you connect.</strong> When you connect an AI app (over MCP), you are letting it read and
            write what you allow. What it does with data it reads is between you and that app's provider, and is covered by
            their terms, not this page. You can disconnect any app in Settings.
          </li>
          <li>
            <strong>People you share with.</strong> A share link lets anyone who has it read that item, without an
            account. Treat it like a password and revoke it when you are done.
          </li>
        </ul>
      </Section>

      <Section id="cookies" title="Cookies and local storage">
        <p>
          One cookie, <code>wb_session</code>. It keeps you signed in, is marked HttpOnly (page scripts cannot read it),
          Secure over HTTPS and SameSite=Lax, and lasts {RETENTION.sessionDays} days. It is strictly necessary, so there
          is no cookie banner: there is nothing to opt out of.
        </p>
        <p>
          The app also remembers a few preferences in your browser's local storage, never sent to the server: which
          workspace you last used, where you last panned and zoomed on each mindmap, and whether you show the code view of
          a page. Clearing site data removes them.
        </p>
      </Section>

      <Section id="how-long" title="How long it is kept">
        <ul>
          <li>Your account and content: until you delete them, or delete your account.</li>
          <li>
            Deleted cards, mindmaps and files: kept in the trash for {RETENTION.trashDays} days so you can restore them,
            then removed, together with the stored files behind them.
          </li>
          <li>
            Browser sessions: {RETENTION.sessionDays} days. Connected apps: access tokens last {RETENTION.accessTokenDays}{" "}
            days and are renewed with a refresh token that lasts {RETENTION.refreshTokenDays} days; you can revoke them
            sooner.
          </li>
          <li>
            Version history, embeddings and the log of what your AI tools asked: as long as your account, and removed
            when you delete it.
          </li>
          <li>
            Backups: Cloudflare may keep database backups for a limited time after something is deleted.{" "}
            {ctx.hosted ? (
              <>
                On the hosted service that can be up to <Placeholder k="backupWindow" />.
              </>
            ) : (
              <>How long depends on the operator's Cloudflare plan and settings.</>
            )}
          </li>
        </ul>
      </Section>

      <Section id="your-controls" title="Your controls">
        <ul>
          <li>
            <strong>Export:</strong> Settings → "Download my data" gives you one zip of everything you own, with the
            original files and version history.
          </li>
          <li>
            <strong>Delete:</strong> Settings → "Delete account" closes your account at once (nobody can sign in as you or
            reach your content) and then deletes what you own, its stored files, its version history and its search
            entries. If other people are in a workspace you own, you remove them first. A bare, anonymised account record
            remains, because other people's content can refer to it (a card you wrote in their workspace stays theirs).
          </li>
          <li>
            <strong>Disconnect apps and revoke share links</strong> any time in Settings and the share menu.
          </li>
          <li>
            Depending on where you live, you may have other rights over your data, such as correction or objection. Ask
            using the contact below.
          </li>
        </ul>
      </Section>

      <Section id="security" title="Security">
        <p>
          Passwords and session tokens are stored only as hashes. HTML artefacts run in a sandbox on a separate address
          with no access to your session. No system is perfectly secure; to report a problem see{" "}
          <a href={SECURITY_URL} rel="noreferrer noopener">
            SECURITY.md
          </a>
          .
        </p>
      </Section>

      <Section id="children" title="Children">
        <p>
          {ctx.hosted ? (
            <>
              The hosted service is not for anyone under <Placeholder k="minimumAge" />.
            </>
          ) : (
            <>The operator decides who may use this instance and any minimum age.</>
          )}
        </p>
      </Section>

      <Section id="changes" title="Changes">
        <p>
          If this policy changes in a way that matters, {who} will change the date above and say so in the app or on this
          page. The history of this page is public in the project's repository.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <p>
          Questions, or a request about your data: <Contact ctx={ctx} />
        </p>
        <p className="legal-meta">
          The source code is at{" "}
          <a href={REPO_URL} rel="noreferrer noopener">
            {REPO_URL.replace("https://", "")}
          </a>
          , so every claim here can be checked.
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Terms of service
// ---------------------------------------------------------------------------

export function TermsPage() {
  const { ctx } = useLegalInfo();
  return (
    <LegalLayout title="Terms of service">
      {!ctx ? <Loading /> : <TermsBody ctx={ctx} />}
    </LegalLayout>
  );
}

function TermsBody({ ctx }: { ctx: Ctx }) {
  const who = ctx.who;
  return (
    <>
      <p className="legal-meta" data-testid="effective">
        {ctx.hosted ? (
          <>
            Effective: <Placeholder k="effectiveDate" />
          </>
        ) : (
          <>Template text. The operator sets the date it applies from.</>
        )}
      </p>
      <WhoRunsThis ctx={ctx} page="terms" />

      <p>
        These terms are between you and {who}, who runs this instance of Mindmaps. By creating an account or using it
        you agree to them. If you do not agree, do not use it. How your data is handled is in the{" "}
        <Link to="/privacy">privacy policy</Link>.
      </p>

      <Section id="service" title="The service">
        <p>
          Mindmaps lets you keep mindmaps, cards, documents, sheets, decks, pages and files, search them, share them, and
          let AI tools you connect read and write them. The software is open source under the MIT licence (see the{" "}
          <a href={REPO_URL} rel="noreferrer noopener">
            repository
          </a>
          ); these terms are about using this running instance, not the licence on the code.
        </p>
      </Section>

      <Section id="account" title="Your account">
        <ul>
          <li>Give accurate details and keep your password to yourself. You are responsible for what happens under your account.</li>
          <li>
            Sign-up may be limited (the first account is the owner, others may need an invitation), and {who} can decide
            who gets an account.
          </li>
          <li>
            {ctx.hosted ? (
              <>
                You must be at least <Placeholder k="minimumAge" /> to use the hosted service.
              </>
            ) : (
              <>The operator decides who may use this instance, including any minimum age.</>
            )}
          </li>
        </ul>
      </Section>

      <Section id="content" title="Your content">
        <ul>
          <li>What you put in is yours. {who} does not claim ownership of it.</li>
          <li>
            You give {who} permission to store, process and display it as needed to run the service for you and the people
            you share it with, including making search embeddings, version history and backups. That permission ends when
            you delete it, subject to the retention periods in the privacy policy.
          </li>
          <li>You are responsible for your content and for having the right to put it here.</li>
          <li>
            Share links work for anyone who has them. You are responsible for who you give them to.
          </li>
        </ul>
      </Section>

      <Section id="use" title="Using it properly">
        <p>Do not:</p>
        <ul>
          <li>use it to break the law, or to store or share content you have no right to, or that is abusive or harmful to others;</li>
          <li>try to get into other people's accounts or data, or probe the service for weaknesses outside the good-faith research described in <a href={SECURITY_URL} rel="noreferrer noopener">SECURITY.md</a>;</li>
          <li>overload the service, or send automated traffic at a scale a person using it would not;</li>
          <li>use HTML artefacts or shared pages to attack, phish or mislead anyone, or to distribute malware;</li>
          <li>resell access to the service or pretend to be someone else.</li>
        </ul>
        <p>{who} can remove content or suspend an account that breaks these rules, and will say why where it can.</p>
      </Section>

      <Section id="agents" title="AI tools you connect">
        <p>
          When you connect an AI app, you authorise it to act for you within the access you approved. What it reads and
          writes is treated as your own use of the service, and its own provider's terms govern what it does with the
          data. Connections can be revoked in Settings.
        </p>
      </Section>

      <Section id="as-is" title="No guarantees">
        <p>
          The service is provided as it is, without promises that it will be uninterrupted, error-free or fit for a
          particular purpose, and it may change or stop. Keep your own copy of anything important: Settings → "Download my
          data" exports everything you own.
        </p>
      </Section>

      <Section id="ending" title="Ending your use">
        <p>
          You can stop at any time and delete your account in Settings, which deletes what you own.{" "}
          {Cap(who)} may suspend or close an account that breaks these terms or puts the service or others at risk.
        </p>
      </Section>

      <Section id="liability" title="Liability">
        {ctx.hosted ? (
          <p>
            To the extent the law allows, the hosted service's liability to you is limited to <Placeholder k="liabilityCap" />
            , and it is not liable for indirect or consequential loss. Nothing here limits liability that cannot be limited
            by law.
          </p>
        ) : (
          <p>
            The operator of this instance sets their own limits on liability. The software itself comes with no warranty
            (see the MIT licence). Nothing here limits liability that cannot be limited by law.
          </p>
        )}
      </Section>

      <Section id="law" title="Governing law and disputes">
        {ctx.hosted ? (
          <p>
            These terms are governed by <Placeholder k="governingLaw" />, and disputes go to <Placeholder k="jurisdiction" />.
            This does not remove any rights you have under the mandatory law of where you live.
          </p>
        ) : (
          <p>
            Which law applies, and where disputes are heard, is for the operator of this instance to state. They have not
            been decided by the Mindmaps project.
          </p>
        )}
      </Section>

      <Section id="changes" title="Changes">
        <p>
          {Cap(who)} may update these terms. If a change matters, the date above changes and you will be told in the app or
          on this page; continuing to use the service afterwards means you accept the new terms.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <p>
          <Contact ctx={ctx} />
        </p>
      </Section>
    </>
  );
}

const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
