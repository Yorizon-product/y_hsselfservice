import { getDb, type JobRow } from "./db";
import {
  createCompany,
  createContact,
  createNote,
  patchCompanyDomain,
  associateCompanies,
  rollbackEntities,
  hubspotRecordUrl,
  type CompanyInput,
  type CreatedEntity,
  type TrackedId,
} from "./hubspot-entities";
import { pollCompanyReadiness, PortalStatusError } from "./portal-status";

// In-process job worker. Runs one job at a time on a 500ms tick. Lives
// inside the Next.js Node process on self-hosted deployments; never
// starts on Vercel (RUN_WORKER env gate in startWorker).

export type JobPhase = "partner" | "customer" | "associate";

export type JobPayload = {
  partner: CompanyInput | null;
  customer: CompanyInput | null;
  portalRole?: string;
  partnerRole?: string;
  customerRole?: string;
  portalId?: string | null;
  userEmail?: string | null;
  hubspotOwnerId: string;
  // Access token captured at enqueue time (post-refresh-if-needed).
  // Iron-session refresh logic already bought us ~55min of TTL — more
  // than the worst-case ~500s job runtime.
  accessToken: string;
};

const PORTAL_STATUS_POLL_ENABLED = process.env.PORTAL_STATUS_POLL !== "off";
const PORTAL_STATUS_POLL_KEEP_ON_FAIL = process.env.PORTAL_STATUS_POLL_KEEP_ON_FAIL === "1";
const VALID_ROLES = new Set(["Admin-RW", "User-RW", "User-RO"]);
const DEFAULT_ROLE = "User-RO";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function startWorker(): void {
  if (running) return;
  if (process.env.RUN_WORKER !== "1") {
    console.log("[worker] RUN_WORKER not set; not starting job worker");
    return;
  }
  running = true;
  // On boot, mark any jobs that were `running` when the process died
  // as `failed` with a process-restart reason — the worker does not
  // resume partial work because we don't keep track of which phase /
  // sub-step was in flight. This leaves orphan HubSpot records for
  // interrupted jobs; operators inspect the DB + HubSpot to clean up.
  try {
    const db = getDb();
    const { changes } = db
      .prepare(
        `UPDATE jobs
           SET status='failed',
               error = COALESCE(error, 'Process restarted mid-job. Any records created up to this point may remain in HubSpot.'),
               updated_at = datetime('now')
         WHERE status='running'`
      )
      .run();
    if (changes > 0) console.log(`[worker] marked ${changes} stuck 'running' jobs as failed`);
  } catch (e: any) {
    console.error("[worker] boot reconciliation failed:", e?.message);
  }
  console.log("[worker] started");
  schedule(0);
}

function schedule(delayMs: number) {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
}

async function tick(): Promise<void> {
  if (!running) return;
  let claimed: JobRow | null = null;
  try {
    claimed = claimPendingJob();
  } catch (e: any) {
    console.error("[worker] claim failed:", e?.message);
  }
  if (claimed) {
    try {
      await executeJob(claimed);
    } catch (e: any) {
      console.error(`[worker] executeJob crashed for ${claimed.id}:`, e?.message);
      try {
        finalizeFailure(claimed.id, e?.message || "Unknown worker error", null, null, []);
      } catch {
        /* best effort */
      }
    }
    // Drain the queue before idling.
    schedule(0);
    return;
  }
  schedule(500);
}

function claimPendingJob(): JobRow | null {
  const db = getDb();
  const claim = db.transaction((): JobRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1`
      )
      .get() as JobRow | undefined;
    if (!row) return null;
    const res = db
      .prepare(
        `UPDATE jobs
           SET status='running', updated_at=datetime('now')
         WHERE id=? AND status='pending'`
      )
      .run(row.id);
    if (res.changes === 0) return null;
    return { ...row, status: "running" };
  });
  return claim();
}

function setPhase(id: string, phase: JobPhase): void {
  getDb()
    .prepare(
      `UPDATE jobs
         SET phase=?, updated_at=datetime('now')
       WHERE id=?`
    )
    .run(phase, id);
}

function appendCreated(id: string, entry: CreatedEntity, tracked?: TrackedId): void {
  const db = getDb();
  const row = db.prepare("SELECT created_json, tracked_ids_json FROM jobs WHERE id=?").get(id) as
    | { created_json: string; tracked_ids_json: string }
    | undefined;
  if (!row) return;
  const created = JSON.parse(row.created_json) as CreatedEntity[];
  const tracked_ids = JSON.parse(row.tracked_ids_json) as TrackedId[];
  created.push(entry);
  if (tracked) tracked_ids.push(tracked);
  db.prepare(
    `UPDATE jobs
       SET created_json=?, tracked_ids_json=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(JSON.stringify(created), JSON.stringify(tracked_ids), id);
}

function finalizeSuccess(id: string): void {
  getDb()
    .prepare(
      `UPDATE jobs
         SET status='succeeded', phase=NULL, updated_at=datetime('now')
       WHERE id=?`
    )
    .run(id);
}

function finalizeFailure(
  id: string,
  error: string,
  code: string | null,
  rawStatus: string | null,
  kept: Array<{ type: string; id: string; url: string }>
): void {
  getDb()
    .prepare(
      `UPDATE jobs
         SET status='failed',
             error=?,
             code=?,
             raw_status=?,
             kept_json=?,
             updated_at=datetime('now')
       WHERE id=?`
    )
    .run(error, code, rawStatus, JSON.stringify(kept), id);
}

async function executeJob(job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload_json) as JobPayload;
  const headers = {
    Authorization: `Bearer ${payload.accessToken}`,
    "Content-Type": "application/json",
  };
  const createdIds: TrackedId[] = [];
  const createdBy = payload.userEmail || "unknown";
  const noteBody = `Created via HS Self-Service tool by ${createdBy} on ${new Date().toISOString().slice(0, 10)}`;

  const resolveRole = (perEntity?: string, shared?: string): string => {
    const role = perEntity ?? shared ?? DEFAULT_ROLE;
    if (!VALID_ROLES.has(role)) throw new Error(`Invalid portal role: ${role}`);
    return role;
  };

  const partnerRole = payload.partner ? resolveRole(payload.partnerRole, payload.portalRole) : undefined;
  const customerRole = payload.customer ? resolveRole(payload.customerRole, payload.portalRole) : undefined;

  const doSide = async (
    side: "partner" | "customer",
    input: CompanyInput,
    role: string
  ): Promise<{ companyId: string }> => {
    const sideUpper: "PARTNER" | "CUSTOMER" = side === "partner" ? "PARTNER" : "CUSTOMER";
    setPhase(job.id, side);
    console.log(`[worker] job=${job.id} side=${side} creating company "${input.name}"`);

    const company = await createCompany(headers, input.name, sideUpper, payload.hubspotOwnerId);
    createdIds.push({ type: "companies", id: company.id, label: `${side}_company` });
    appendCreated(
      job.id,
      {
        type: side === "partner" ? "Partner Company" : "Customer Company",
        id: company.id,
        name: input.name,
        url: hubspotRecordUrl(payload.portalId, "company", company.id),
      },
      { type: "companies", id: company.id, label: `${side}_company` }
    );

    // Best-effort note.
    try {
      await createNote(headers, noteBody, "companies", company.id);
    } catch (e: any) {
      console.error(`[worker] job=${job.id} ${side} company note failed: ${e.message}`);
    }

    if (PORTAL_STATUS_POLL_ENABLED) {
      await pollCompanyReadiness(
        payload.accessToken,
        company.id,
        new Date(company.createdAt),
        (line) => console.log(`${line} job=${job.id} side=${side}`)
      );
    }

    if (input.domain) {
      try {
        await patchCompanyDomain(headers, company.id, input.domain);
      } catch (e: any) {
        console.error(`[worker] job=${job.id} ${side} domain patch failed: ${e.message}`);
      }
    }

    const contact = await createContact(headers, input.contact, company.id, role);
    createdIds.push({ type: "contacts", id: contact.id, label: `${side}_contact` });
    appendCreated(
      job.id,
      {
        type: side === "partner" ? "Partner Contact" : "Customer Contact",
        id: contact.id,
        name: `${input.contact.firstname} ${input.contact.lastname}`.trim() || input.contact.email,
        url: hubspotRecordUrl(payload.portalId, "contact", contact.id),
      },
      { type: "contacts", id: contact.id, label: `${side}_contact` }
    );
    try {
      await createNote(headers, noteBody, "contacts", contact.id);
    } catch (e: any) {
      console.error(`[worker] job=${job.id} ${side} contact note failed: ${e.message}`);
    }

    return { companyId: company.id };
  };

  try {
    let partnerCompanyId: string | null = null;
    let customerCompanyId: string | null = null;

    if (payload.partner) {
      const r = await doSide("partner", payload.partner, partnerRole!);
      partnerCompanyId = r.companyId;
    }
    if (payload.customer) {
      const r = await doSide("customer", payload.customer, customerRole!);
      customerCompanyId = r.companyId;
    }
    if (partnerCompanyId && customerCompanyId) {
      setPhase(job.id, "associate");
      console.log(`[worker] job=${job.id} associating partner=${partnerCompanyId} customer=${customerCompanyId}`);
      await associateCompanies(headers, partnerCompanyId, customerCompanyId);
      appendCreated(job.id, {
        type: "Association",
        id: `${partnerCompanyId}↔${customerCompanyId}`,
        name: `${payload.partner!.name} ↔ ${payload.customer!.name}`,
        url: hubspotRecordUrl(payload.portalId, "company", partnerCompanyId),
      });
    }

    finalizeSuccess(job.id);
    console.log(`[worker] job=${job.id} succeeded (${createdIds.length} entities created)`);
  } catch (stepError: any) {
    const portalCode = stepError instanceof PortalStatusError ? stepError.code : null;
    const rawStatus = stepError instanceof PortalStatusError ? stepError.rawStatus ?? null : null;
    const skipRollback = !!(portalCode && PORTAL_STATUS_POLL_KEEP_ON_FAIL);
    console.error(`[worker] job=${job.id} failed: ${stepError.message}`);

    let kept: Array<{ type: string; id: string; url: string }> = [];
    if (!skipRollback && createdIds.length > 0) {
      const result = await rollbackEntities(headers, createdIds, fetch, (line) => console.log(`${line} job=${job.id}`));
      if (result.failed.length > 0) {
        kept = result.failed.map(f => ({
          type: f.entity.label,
          id: f.entity.id,
          url: hubspotRecordUrl(payload.portalId, f.entity.type === "companies" ? "company" : "contact", f.entity.id),
        }));
        console.error(`[worker] job=${job.id} rollback incomplete: ${result.failed.length} entities remain`);
      }
    } else if (skipRollback) {
      kept = createdIds.map(e => ({
        type: e.label,
        id: e.id,
        url: hubspotRecordUrl(payload.portalId, e.type === "companies" ? "company" : "contact", e.id),
      }));
    }

    finalizeFailure(job.id, stepError.message, portalCode, rawStatus, kept);
  }
}
