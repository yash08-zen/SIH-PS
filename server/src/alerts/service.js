import { RULESET_VERSION } from '../../config/redflag-rules.v1.js';
import { QUESTIONS } from '../../config/questions.v1.js';
import { displayAnswer, getQuestion } from '../interview/dialogue.js';
import { audit } from '../patients.js';
import { evaluateRules } from './rules.js';
import { textMatches } from './textscan.js';

const LEVEL_PRIORITY = { emergency: 100, attention: 50 };
const ACKNOWLEDGED_PRIORITY = 10; // still ahead of routine cases (0) until the consultation is over
const LANGS = ['en', 'hi', 'mr'];

// The urgent-help button: the patient says they need help now, whatever the questions asked. Always an emergency alert.
export const URGENT_RULE = {
  id: 'RF-URGENT-BUTTON', version: 1, level: 'emergency',
  reason: ['The patient pressed the urgent help button', 'मरीज़ ने तुरंत मदद का बटन दबाया', 'रुग्णाने तातडीच्या मदतीचे बटण दाबले'],
};

// Token numbers restart each day; the advisory lock makes concurrent registrations take different numbers.
export async function nextToken(db) {
  await db.query('SELECT pg_advisory_xact_lock(7001)');
  const { rows: [r] } = await db.query(`SELECT coalesce(max(token_number), 0) + 1 AS n FROM queue_entries WHERE created_at >= date_trunc('day', now())`);
  return r.n;
}

export async function addToQueue(db, encounterId) {
  const token = await nextToken(db);
  await db.query('INSERT INTO queue_entries (encounter_id, token_number) VALUES ($1, $2) ON CONFLICT (encounter_id) DO NOTHING', [encounterId, token]);
  return token;
}

const VIEW_SQL = `
  SELECT a.id, a.encounter_id, a.rule_id, a.rule_version, a.level, a.evidence, a.raised_at, a.acknowledged_at,
         u.full_name AS acknowledged_by_name, e.status AS encounter_status, e.department_id,
         q.token_number, p.patientcase_id, p.full_name AS patient_name
    FROM alerts a
    JOIN encounters e ON e.id = a.encounter_id
    JOIN patients p ON p.id = e.patient_id
    LEFT JOIN queue_entries q ON q.encounter_id = e.id
    LEFT JOIN users u ON u.id = a.acknowledged_by`;

export const toView = (r) => ({
  id: r.id, encounterId: r.encounter_id, token: r.token_number, patientcaseId: r.patientcase_id, patientName: r.patient_name,
  ruleId: r.rule_id, ruleVersion: r.rule_version, level: r.level, reason: r.evidence.reason, triggers: r.evidence.triggers,
  raisedAt: r.raised_at, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by_name, encounterStatus: r.encounter_status,
});

export function createAlertService({ pool, hub }) {
  async function recomputePriority(db, encounterId) {
    const { rows } = await db.query('SELECT level, acknowledged_at FROM alerts WHERE encounter_id = $1', [encounterId]);
    const priority = rows.reduce((m, r) => Math.max(m, r.acknowledged_at ? ACKNOWLEDGED_PRIORITY : LEVEL_PRIORITY[r.level]), 0);
    await db.query('UPDATE queue_entries SET priority = $2 WHERE encounter_id = $1', [encounterId, priority]);
  }

  // Open alerts and recently acknowledged ones. Doctors see their department's patients (department-level routing).
  async function list({ role, departmentId = null }) {
    const { rows } = await pool.query(
      `${VIEW_SQL}
        WHERE (a.acknowledged_at IS NULL OR a.acknowledged_at > now() - interval '4 hours')
          AND ($1 <> 'doctor' OR $2::uuid IS NULL OR e.department_id IS NULL OR e.department_id = $2::uuid)
        ORDER BY (a.acknowledged_at IS NOT NULL), (a.level = 'emergency') DESC, a.raised_at`, [role, departmentId]);
    return rows.map(toView);
  }

  // Evidence is stored in all three languages so staff and doctors read it in their own language.
  function evidenceFor(match, answers) {
    return {
      rulesetVersion: RULESET_VERSION,
      reason: match.rule.reason,
      triggers: match.triggerKeys.map((key) => {
        const a = answers[key];
        // a question the AI interviewer wrote is kept with its answer, so it can be shown too
        const q = getQuestion(key) ?? (a?.question ? { ...a.question, key } : null);
        return {
          key,
          question: q ? q.text : [key, key, key],
          answer: a.skipped ? null : LANGS.map((l) => (q ? displayAnswer(q, a, l) : String(a.value))),
          skipped: Boolean(a.skipped),
        };
      }),
    };
  }

  // Raises each match once per encounter, tells staff, and sorts the patient up the queue.
  async function raise(encounterId, matches, answers) {
    const raised = [];
    for (const m of matches) {
      const { rows } = await pool.query(
        `INSERT INTO alerts (encounter_id, rule_id, rule_version, level, evidence) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (encounter_id, rule_id) DO NOTHING RETURNING id`,
        [encounterId, m.rule.id, m.rule.version, m.rule.level, evidenceFor(m, answers)]);
      if (!rows.length) continue;
      await pool.query(`UPDATE encounters SET status = 'alert' WHERE id = $1 AND status IN ('registered', 'in_intake')`, [encounterId]);
      await recomputePriority(pool, encounterId);
      await audit(pool, { actorType: 'system', action: 'alert_raised', objectType: 'alert', objectId: rows[0].id, detail: { ruleId: m.rule.id, ruleVersion: m.rule.version, level: m.rule.level, encounterId } });
      const { rows: [row] } = await pool.query(`${VIEW_SQL} WHERE a.id = $1`, [rows[0].id]);
      hub.publish('alert', toView(row), { departmentId: row.department_id });
      raised.push({ ruleId: m.rule.id, reason: m.rule.reason[0] });
    }
    return raised;
  }

  // Evaluate after every saved answer: the structured rules, and the emergency words in what the patient wrote or said.
  // Returns the newly raised alerts (an already-raised rule is not raised twice).
  async function evaluate({ encounterId, answers }) {
    return raise(encounterId, [...evaluateRules(answers), ...textMatches(answers)], answers);
  }

  // The patient pressed the urgent help button.
  async function raiseUrgent(encounterId) {
    return raise(encounterId, [{ rule: URGENT_RULE, triggerKeys: [] }], {});
  }

  // After acknowledgement the encounter returns to In intake (PRD 9.5) once nothing else is waiting for staff.
  async function acknowledge(alertId, userId) {
    const { rows } = await pool.query(
      'UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL RETURNING encounter_id', [alertId, userId]);
    if (!rows.length) return null;
    const encounterId = rows[0].encounter_id;
    const { rows: [{ open }] } = await pool.query('SELECT count(*)::int AS open FROM alerts WHERE encounter_id = $1 AND acknowledged_at IS NULL', [encounterId]);
    if (!open) await pool.query(`UPDATE encounters SET status = 'in_intake' WHERE id = $1 AND status = 'alert'`, [encounterId]);
    await recomputePriority(pool, encounterId);
    await audit(pool, { actorType: 'staff', actorId: userId, userId, action: 'alert_acknowledged', objectType: 'alert', objectId: alertId, detail: { encounterId } });
    const { rows: [row] } = await pool.query(`${VIEW_SQL} WHERE a.id = $1`, [alertId]);
    const view = toView(row);
    hub.publish('ack', view, { departmentId: row.department_id });
    return view;
  }

  // Staff queue: alerts first (priority), then token order.
  async function queue() {
    const { rows } = await pool.query(
      `SELECT q.token_number, q.priority, e.id AS encounter_id, e.status, e.ayush_mode, e.department_id, p.full_name, p.patientcase_id, p.preferred_language,
              r.answer->>'value' AS complaint,
              (SELECT count(*)::int FROM alerts a WHERE a.encounter_id = e.id AND a.acknowledged_at IS NULL) AS open_alerts
         FROM queue_entries q
         JOIN encounters e ON e.id = q.encounter_id
         JOIN patients p ON p.id = e.patient_id
         LEFT JOIN interview_responses r ON r.encounter_id = e.id AND r.question_key = 'cc.main'
        WHERE e.status <> 'completed' AND q.created_at >= date_trunc('day', now())
        ORDER BY q.priority DESC, q.token_number`);
    const complaintOptions = QUESTIONS.find((q) => q.key === 'cc.main').options;
    return rows.map((r) => ({
      token: r.token_number, priority: r.priority, encounterId: r.encounter_id, status: r.status, patientName: r.full_name,
      patientcaseId: r.patientcase_id, openAlerts: r.open_alerts, ayush: r.ayush_mode, departmentId: r.department_id,
      complaint: r.complaint ? { key: r.complaint, label: complaintOptions.find((o) => o.value === r.complaint)?.label ?? [r.complaint, r.complaint, r.complaint] } : null,
    }));
  }

  return {
    name: 'rules-v1', evaluate, raiseUrgent, acknowledge, list, queue,
  };
}

// Adapter with the interface the interview router expects (evaluate -> flags raised).
export function createRedFlagEvaluator(service) {
  return { name: 'rules-v1', evaluate: (arg) => service.evaluate(arg), urgent: (encounterId) => service.raiseUrgent(encounterId) };
}
