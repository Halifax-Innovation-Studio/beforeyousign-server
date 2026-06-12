const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  loadClauseDataset,
  validateClauseDataset,
  getApplicableRules,
  getRowsByClauseType,
  datasetMeta,
  DEFAULT_DATASET_PATH,
} = require('../lib/clauseDataset');

const SEED_ROW_IDS = ['rc-001', 'rc-002', 'lp-001', 'sl-001', 'es-001', 'cc-001', 'cc-002'];
// T9B-T9F traced all 7 seed rows (sl-001, es-001, rc-001/rc-002, lp-001,
// cc-001/cc-002). Traced means verified against official text as of the
// traced_date - the dataset remains seed-incomplete (7 synthetic rows vs the
// 20-50 target) and shipping-mode loadability is not a readiness claim.
const SEED_TRACED_IDS = [...SEED_ROW_IDS];
const SEED_PLACEHOLDER_IDS = SEED_ROW_IDS.filter((id) => !SEED_TRACED_IDS.includes(id));

function makeStatuteSource(overrides = {}) {
  return {
    source_type: 'statute',
    title: 'Residential Tenancies Act (test fixture)',
    url: 'https://example.invalid/rta',
    publisher: 'Office of the Legislative Counsel (test fixture)',
    retrieved_date: '2026-06-11',
    provision: 's. 11A',
    quote_or_summary: 'Test fixture quote of the provision text.',
    notes: null,
    ...overrides,
  };
}

// Minimal valid schema-v2 dataset: one fully traced row, one placeholder row.
function makeDataset(overrides = {}) {
  return {
    dataset_version: 'test',
    schema_version: 2,
    status: 'test',
    rows: [
      {
        id: 'row-1',
        clause_type: 'rent-escalation',
        rule_summary: 'Rent increases are capped.',
        statute_ref: 'RTA s.11A',
        source: 'test source',
        valid_from: '2026-01-01',
        valid_to: '2027-12-31',
        expected_flag: 'ok',
        expected_explanation_points: ['within the cap'],
        trace_status: 'traced',
        confidence: 'high',
        trace_sources: [makeStatuteSource()],
        traced_date: '2026-06-11',
      },
      {
        id: 'row-2',
        clause_type: 'sublet',
        rule_summary: 'Subtenant rent may not exceed lease rent.',
        statute_ref: 'TO-TRACE (RTA amendments)',
        source: 'test source',
        valid_from: '2024-09-20',
        valid_to: null,
        expected_flag: 'flag',
        expected_explanation_points: ['sublet rent above lease rent not permitted'],
        trace_status: 'placeholder',
        confidence: null,
        trace_sources: [],
        traced_date: null,
      },
    ],
    ...overrides,
  };
}

function mutateRow(index, mutation) {
  const dataset = makeDataset();
  Object.assign(dataset.rows[index], mutation);
  return dataset;
}

function errorsOf(dataset, mode = 'dev') {
  return validateClauseDataset(dataset, { mode }).errors;
}

// --- seed dataset (the committed snapshot) ---

// 1–2. Current seed loads in dev and eval mode.
test('seed snapshot loads in dev mode: all 7 rows traced, no warnings', () => {
  const loaded = loadClauseDataset({ mode: 'dev' });
  assert.equal(loaded.meta.schemaVersion, 2);
  assert.equal(loaded.meta.rowCount, 7);
  assert.equal(loaded.rows.length, 7);
  assert.deepEqual(loaded.warnings, [], 'no untraced rows remain, so no warnings expected');
  const byId = Object.fromEntries(loaded.rows.map((r) => [r.id, r]));
  for (const id of SEED_PLACEHOLDER_IDS) {
    assert.equal(byId[id].trace_status, 'placeholder', `${id} must remain placeholder`);
    assert.equal(byId[id].isTraced, false);
    assert.equal(byId[id].traceStatus, 'placeholder');
  }
  for (const id of SEED_TRACED_IDS) {
    assert.equal(byId[id].trace_status, 'traced', `${id} must be traced`);
    assert.equal(byId[id].isTraced, true);
    assert.equal(byId[id].traceStatus, 'traced');
  }
});

test('seed es-001 row carries a complete official trace with corrected window', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  const row = loaded.rows.find((r) => r.id === 'es-001');
  assert.ok(row, 'es-001 must exist');
  assert.equal(row.trace_status, 'traced');
  assert.equal(row.confidence, 'high');
  assert.ok(!row.statute_ref.startsWith('TO-TRACE'));
  assert.ok(row.statute_ref.includes('15(1)(e)') && row.statute_ref.includes('15(2)(e)'), 'statute_ref must pinpoint RTA s. 15 service clauses');
  assert.equal(row.valid_from, '2025-04-30', 'valid_from must be the proclamation date, not the 2024 royal-assent date');
  assert.equal(row.valid_to, null);
  assert.equal(row.traced_date, '2026-06-11');
  assert.ok(Array.isArray(row.trace_sources) && row.trace_sources.length >= 2);
  assert.ok(
    row.trace_sources.some((s) => ['statute', 'regulation', 'amending-act'].includes(s.source_type)),
    'es-001 must carry at least one official trace authority'
  );
  assert.ok(row.isTraced, 'derived isTraced must be true');
  assert.ok(
    /prior, different electronic-service regime|NOT modeled/i.test(row.notes),
    'row notes must preserve the pre-2025 regime limitation'
  );
});

test('seed rent-cap pair rc-001/rc-002 carries a complete official trace with corrected window', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  const byId = Object.fromEntries(loaded.rows.map((r) => [r.id, r]));
  for (const id of ['rc-001', 'rc-002']) {
    const row = byId[id];
    assert.ok(row, `${id} must exist`);
    assert.equal(row.trace_status, 'traced');
    assert.equal(row.confidence, 'high');
    assert.ok(!row.statute_ref.startsWith('TO-TRACE'));
    assert.ok(
      row.statute_ref.includes('2021, c. 22') && row.statute_ref.includes('79/2023'),
      `${id} statute_ref must cite the Cap Act and Cap Regulations`
    );
    assert.equal(row.valid_from, '2024-01-01', `${id} valid_from must be the legal effective date of the 5% rate`);
    assert.equal(row.valid_to, '2027-12-31', `${id} valid_to must be the Act expiry date`);
    assert.equal(row.traced_date, '2026-06-11');
    assert.ok(row.isTraced);
    assert.ok(
      row.trace_sources.some((s) => s.source_type === 'statute') &&
        row.trace_sources.some((s) => s.source_type === 'regulation'),
      `${id} must carry both Act and Regulations sources`
    );
  }
  assert.equal(byId['rc-001'].expected_flag, 'ok', 'rc-001 within-cap case stays ok');
  assert.equal(byId['rc-002'].expected_flag, 'flag', 'rc-002 over-cap case stays flag');
  assert.ok(/2% period|NOT modeled/i.test(byId['rc-001'].notes), 'rc-001 notes must preserve the pre-2024 limitation');
  assert.ok(/NEVER score 'ok'/.test(byId['rc-002'].notes), 'rc-002 harmful-failure guard note must survive');
  // T2 ticket acceptance boundaries against the real dataset:
  const rcIds = (rows) => rows.map((r) => r.id).filter((id) => id.startsWith('rc-'));
  assert.deepEqual(rcIds(getApplicableRules(loaded.rows, '2027-12-31')), ['rc-001', 'rc-002'], '2027-12-31 in-window');
  assert.deepEqual(rcIds(getApplicableRules(loaded.rows, '2028-01-01')), [], '2028-01-01 out-of-window');
  assert.deepEqual(rcIds(getApplicableRules(loaded.rows, '2024-01-01')), ['rc-001', 'rc-002'], 'valid_from boundary in-window');
  assert.deepEqual(rcIds(getApplicableRules(loaded.rows, '2023-12-31')), [], 'day before valid_from out-of-window');
});

test('seed lp-001 row carries a complete official trace', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  const row = loaded.rows.find((r) => r.id === 'lp-001');
  assert.ok(row, 'lp-001 must exist');
  assert.equal(row.trace_status, 'traced');
  assert.equal(row.confidence, 'high');
  assert.ok(!row.statute_ref.startsWith('TO-TRACE'));
  assert.ok(
    row.statute_ref.includes('10(6)') && row.statute_ref.includes('2(aa)'),
    'statute_ref must pinpoint the arrears timeline and the calendar-day definition'
  );
  assert.equal(row.valid_from, '2025-04-30', 'valid_from is the proclamation date of the 3/10 timeline');
  assert.equal(row.valid_to, null);
  assert.equal(row.traced_date, '2026-06-11');
  assert.equal(row.expected_flag, 'flag', 'business-days clause stays a flag case');
  assert.ok(row.isTraced);
  assert.ok(
    row.trace_sources.some((s) => ['statute', 'regulation', 'amending-act'].includes(s.source_type)),
    'lp-001 must carry at least one official trace authority'
  );
  assert.ok(/calendar day/i.test(row.rule_summary), 'calendar-day rule stays in the summary');
  assert.ok(
    /pre-2025 regime|week-to-week/i.test(row.notes),
    'row notes must preserve the pre-2025 and week-to-week limitations'
  );
  assert.ok(
    row.expected_explanation_points.some((p) => /not an eviction/i.test(p)),
    'explanation points must distinguish notice to quit from eviction'
  );
});

test('seed completeness pair cc-001/cc-002 carries a complete official trace with corrected window', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  const byId = Object.fromEntries(loaded.rows.map((r) => [r.id, r]));
  for (const id of ['cc-001', 'cc-002']) {
    const row = byId[id];
    assert.ok(row, `${id} must exist`);
    assert.equal(row.trace_status, 'traced');
    assert.equal(row.confidence, 'high');
    assert.ok(!row.statute_ref.startsWith('TO-TRACE'));
    assert.ok(row.statute_ref.includes('7A'), `${id} statute_ref must pinpoint RTA s. 7A`);
    assert.equal(row.valid_from, '2025-04-30', `${id} valid_from must be the proclamation date (was null in the seed)`);
    assert.equal(row.valid_to, null);
    assert.equal(row.traced_date, '2026-06-11');
    assert.ok(row.isTraced);
    assert.ok(
      row.trace_sources.some((s) => ['statute', 'regulation', 'amending-act'].includes(s.source_type)),
      `${id} must carry at least one official trace authority`
    );
  }
  assert.equal(byId['cc-001'].expected_flag, 'ok', 'cc-001 completeness-positive case stays ok');
  assert.equal(byId['cc-002'].expected_flag, 'missing', 'cc-002 completeness-negative case stays missing');
  assert.ok(/NEVER score 'ok' or 'present'/.test(byId['cc-002'].notes), 'cc-002 harmful-failure guard note must survive');
  assert.ok(
    /property manager|superintendent/i.test(byId['cc-001'].rule_summary),
    'cc-001 rule_summary must reflect the expanded statutory element set'
  );
  assert.ok(
    byId['cc-002'].expected_explanation_points.some((p) => /only if such a person exists/i.test(p)),
    'cc-002 must not treat conditional persons as unconditionally required'
  );
  assert.ok(
    /transitional|written notice/i.test(byId['cc-001'].notes) && /not a legal-noncompliance conclusion|transitional/i.test(byId['cc-002'].expected_explanation_points.join(' ')),
    'the s. 7A(3) transitional-notice nuance must be preserved'
  );
});

test('seed sl-001 row carries a complete official trace', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  const row = loaded.rows.find((r) => r.id === 'sl-001');
  assert.ok(row, 'sl-001 must exist');
  assert.equal(row.trace_status, 'traced');
  assert.equal(row.confidence, 'high');
  assert.ok(!row.statute_ref.startsWith('TO-TRACE'));
  assert.ok(row.statute_ref.includes('9B(6)'), 'statute_ref must pinpoint RTA s. 9B(6)');
  assert.equal(row.valid_from, '2024-09-20');
  assert.equal(row.valid_to, null);
  assert.equal(row.traced_date, '2026-06-11');
  assert.ok(Array.isArray(row.trace_sources) && row.trace_sources.length >= 1);
  assert.ok(
    row.trace_sources.some((s) => ['statute', 'regulation', 'amending-act'].includes(s.source_type)),
    'sl-001 must carry at least one official trace authority'
  );
});

test('seed snapshot loads in eval mode', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  assert.equal(loaded.rows.length, 7);
});

// 3. With all 7 seed rows traced, shipping mode now loads. This closes the
// trace gate for the current seed rows ONLY - it is not a completeness,
// validation, or production-readiness claim (dataset is 7 synthetic rows vs
// the 20-50 target).
test('seed snapshot loads in shipping mode now that every row is traced', () => {
  const loaded = loadClauseDataset({ mode: 'shipping' });
  assert.equal(loaded.rows.length, 7);
  assert.ok(loaded.rows.every((row) => row.isTraced && row.trace_status === 'traced'));
  assert.deepEqual(loaded.warnings, []);
});

// 4. Missing mode still fails.
test('mode is required and must be shipping, dev, or eval', () => {
  assert.throws(() => loadClauseDataset(), /mode is required/);
  assert.throws(() => loadClauseDataset({ mode: 'production' }), /mode is required/);
  assert.throws(() => validateClauseDataset(makeDataset(), {}), /mode is required/);
});

// --- top-level schema ---

// 5–6. Unsupported schema versions fail, including v1.
test('unsupported schema_version fails', () => {
  assert.ok(errorsOf(makeDataset({ schema_version: 3 })).some((e) => e.includes('unsupported schema_version')));
  assert.ok(errorsOf(makeDataset({ schema_version: undefined })).some((e) => e.includes('unsupported schema_version')));
});

test('schema_version 1 is no longer supported', () => {
  assert.ok(errorsOf(makeDataset({ schema_version: 1 })).some((e) => e.includes('unsupported schema_version')));
});

test('empty rows list fails', () => {
  assert.ok(errorsOf(makeDataset({ rows: [] })).some((e) => e.includes('must not be empty')));
});

test('missing rows list fails', () => {
  const dataset = makeDataset();
  delete dataset.rows;
  assert.ok(errorsOf(dataset).some((e) => e.includes('rows must be a list')));
});

test('row_count mismatch with rows length fails', () => {
  assert.ok(errorsOf(makeDataset({ row_count: 5 })).some((e) => e.includes('row_count')));
});

test('duplicate row ids fail', () => {
  const dataset = makeDataset();
  dataset.rows[1].id = 'row-1';
  assert.ok(errorsOf(dataset).some((e) => e.includes('duplicate id')));
});

test('missing required fields fail', () => {
  for (const field of ['id', 'clause_type', 'rule_summary', 'statute_ref', 'source']) {
    assert.ok(
      errorsOf(mutateRow(0, { [field]: undefined })).some((e) => e.includes(field)),
      `missing ${field} must produce an error naming it`
    );
  }
  assert.ok(errorsOf(mutateRow(0, { rule_summary: '   ' })).some((e) => e.includes('rule_summary')));
});

test('invalid expected_flag fails', () => {
  assert.ok(errorsOf(mutateRow(0, { expected_flag: 'warn' })).some((e) => e.includes('expected_flag')));
});

test('malformed valid_from/valid_to dates fail', () => {
  for (const bad of ['2026/01/01', '01-01-2026', '2026-13-01', '2026-02-30', '2026-1-1', 20260101]) {
    assert.ok(
      errorsOf(mutateRow(0, { valid_from: bad })).some((e) => e.includes('valid_from')),
      `valid_from ${JSON.stringify(bad)} must fail`
    );
  }
  assert.ok(errorsOf(mutateRow(0, { valid_to: '2027-00-10' })).some((e) => e.includes('valid_to')));
});

test('valid_to before valid_from fails', () => {
  const dataset = mutateRow(0, { valid_from: '2026-06-01', valid_to: '2026-05-31' });
  assert.ok(errorsOf(dataset).some((e) => e.includes('before valid_from')));
});

test('empty expected_explanation_points fails', () => {
  assert.ok(
    errorsOf(mutateRow(0, { expected_explanation_points: [] })).some((e) => e.includes('expected_explanation_points'))
  );
});

test('empty string inside expected_explanation_points fails', () => {
  assert.ok(
    errorsOf(mutateRow(0, { expected_explanation_points: ['fine', '  '] })).some((e) =>
      e.includes('expected_explanation_points')
    )
  );
});

test('unconfirmed (null) valid_from is a warning in dev/eval and an error in shipping', () => {
  // row-2 is placeholder, so null valid_from is tolerated outside shipping.
  const dataset = mutateRow(1, { valid_from: null });
  assert.deepEqual(errorsOf(dataset, 'dev').filter((e) => e.includes('valid_from')), []);
  assert.ok(errorsOf(dataset, 'shipping').some((e) => e.includes('confirmed effective date') && e.includes('row-2')));
});

// --- trace_status rules ---

// 7–8. Missing/invalid trace_status fails.
test('missing trace_status fails', () => {
  assert.ok(errorsOf(mutateRow(0, { trace_status: undefined })).some((e) => e.includes('trace_status')));
});

test('invalid trace_status fails', () => {
  assert.ok(errorsOf(mutateRow(0, { trace_status: 'verified' })).some((e) => e.includes('trace_status')));
});

// 9–12. Placeholder consistency rules (errors in every mode).
test('placeholder row without TO-TRACE statute_ref fails', () => {
  const dataset = mutateRow(1, { statute_ref: 'RTA s.26' });
  assert.ok(errorsOf(dataset).some((e) => e.includes('row-2') && e.includes('TO-TRACE')));
});

test('placeholder row with non-null confidence fails', () => {
  assert.ok(errorsOf(mutateRow(1, { confidence: 'high' })).some((e) => e.includes('row-2') && e.includes('confidence')));
});

test('placeholder row with non-empty trace_sources fails', () => {
  const dataset = mutateRow(1, { trace_sources: [makeStatuteSource()] });
  assert.ok(errorsOf(dataset).some((e) => e.includes('row-2') && e.includes('trace_sources')));
});

test('placeholder row with non-null traced_date fails', () => {
  assert.ok(errorsOf(mutateRow(1, { traced_date: '2026-06-11' })).some((e) => e.includes('row-2') && e.includes('traced_date')));
});

// 13–16. Traced consistency rules (errors in every mode).
test('traced row with TO-TRACE statute_ref fails in every mode', () => {
  const dataset = mutateRow(0, { statute_ref: 'TO-TRACE (RTA)' });
  for (const mode of ['dev', 'eval', 'shipping']) {
    assert.ok(
      errorsOf(dataset, mode).some((e) => e.includes('row-1') && e.includes('TO-TRACE')),
      `${mode} mode must reject traced+TO-TRACE`
    );
  }
});

test('traced row with confidence not high fails', () => {
  for (const confidence of ['medium', 'low', null]) {
    assert.ok(
      errorsOf(mutateRow(0, { confidence })).some((e) => e.includes('row-1') && e.includes('confidence high')),
      `traced with confidence ${JSON.stringify(confidence)} must fail`
    );
  }
});

test('traced row with no official source fails', () => {
  assert.ok(errorsOf(mutateRow(0, { trace_sources: [] })).some((e) => e.includes('row-1') && e.includes('official source')));
});

test('traced row with program-page-only source fails', () => {
  const dataset = mutateRow(0, { trace_sources: [makeStatuteSource({ source_type: 'program-page' })] });
  assert.ok(errorsOf(dataset).some((e) => e.includes('row-1') && e.includes('official source')));
});

test('traced row with null valid_from fails in every mode', () => {
  const dataset = mutateRow(0, { valid_from: null });
  for (const mode of ['dev', 'eval', 'shipping']) {
    assert.ok(
      errorsOf(dataset, mode).some((e) => e.includes('row-1') && e.includes('valid_from')),
      `${mode} mode must reject traced row with null valid_from`
    );
  }
});

// 17. Traced row with valid official source passes — in all modes including shipping.
test('fully traced row with official source passes validation, including shipping', () => {
  const dataset = makeDataset({ rows: [makeDataset().rows[0]] });
  for (const mode of ['dev', 'eval', 'shipping']) {
    assert.deepEqual(errorsOf(dataset, mode), [], `${mode} mode must accept a fully traced row`);
  }
  // regulation and amending-act also count as official trace authority
  for (const sourceType of ['regulation', 'amending-act']) {
    const variant = makeDataset({ rows: [makeDataset().rows[0]] });
    variant.rows[0].trace_sources = [makeStatuteSource({ source_type: sourceType })];
    assert.deepEqual(errorsOf(variant, 'shipping'), [], `${sourceType} must count as official`);
  }
});

// 18–19. Partial rules.
test('partial row with no source fails', () => {
  const dataset = mutateRow(0, {
    trace_status: 'partial',
    confidence: 'medium',
    trace_sources: [],
    traced_date: '2026-06-11',
  });
  assert.ok(errorsOf(dataset).some((e) => e.includes('row-1') && e.includes('at least one trace_sources')));
});

test('partial row with medium confidence and source passes dev/eval, fails shipping', () => {
  const dataset = mutateRow(0, {
    trace_status: 'partial',
    confidence: 'medium',
    statute_ref: 'TO-TRACE (provision unresolved)',
    trace_sources: [makeStatuteSource({ source_type: 'program-page', provision: null })],
    traced_date: '2026-06-11',
  });
  for (const mode of ['dev', 'eval']) {
    const { errors, warnings } = validateClauseDataset(dataset, { mode });
    assert.deepEqual(errors, [], `${mode} mode must accept a partial row`);
    assert.ok(warnings.some((w) => w.includes('row-1')), `${mode} mode must warn about row-1`);
  }
  assert.ok(errorsOf(dataset, 'shipping').some((e) => e.includes('row-1') && e.includes('untraced')));
});

test('partial row with high confidence fails', () => {
  const dataset = mutateRow(0, {
    trace_status: 'partial',
    confidence: 'high',
    trace_sources: [makeStatuteSource()],
    traced_date: '2026-06-11',
  });
  assert.ok(errorsOf(dataset).some((e) => e.includes('row-1') && e.includes('low or medium')));
});

// 20. Unresolved rules.
test('unresolved row validates in dev/eval but fails in shipping', () => {
  const dataset = mutateRow(0, {
    trace_status: 'unresolved',
    confidence: 'low',
    statute_ref: 'TO-TRACE (provision not found in official sources)',
    trace_sources: [],
    traced_date: '2026-06-11',
  });
  for (const mode of ['dev', 'eval']) {
    assert.deepEqual(errorsOf(dataset, mode), [], `${mode} mode must accept an unresolved row`);
  }
  assert.ok(errorsOf(dataset, 'shipping').some((e) => e.includes('row-1') && e.includes('untraced')));
});

test('unresolved row without TO-TRACE statute_ref warns but does not error', () => {
  const dataset = mutateRow(0, {
    trace_status: 'unresolved',
    confidence: 'low',
    statute_ref: 'RTA (somewhere)',
    trace_sources: [],
    traced_date: '2026-06-11',
  });
  const { errors, warnings } = validateClauseDataset(dataset, { mode: 'dev' });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('row-1') && w.includes('TO-TRACE')));
});

test('unresolved row with high confidence fails', () => {
  const dataset = mutateRow(0, {
    trace_status: 'unresolved',
    confidence: 'high',
    statute_ref: 'TO-TRACE (not found)',
    trace_sources: [],
    traced_date: '2026-06-11',
  });
  assert.ok(errorsOf(dataset).some((e) => e.includes('row-1') && e.includes('low or medium')));
});

// 21–23. Source-record and trace-date validation.
test('invalid retrieved_date in a source fails', () => {
  for (const bad of ['2026-13-01', 'recently', null]) {
    const dataset = mutateRow(0, { trace_sources: [makeStatuteSource({ retrieved_date: bad })] });
    assert.ok(
      errorsOf(dataset).some((e) => e.includes('retrieved_date')),
      `retrieved_date ${JSON.stringify(bad)} must fail`
    );
  }
});

test('invalid traced_date fails', () => {
  for (const bad of ['2026-02-30', 'yesterday', 20260611]) {
    const dataset = mutateRow(0, { traced_date: bad });
    assert.ok(errorsOf(dataset).some((e) => e.includes('traced_date')), `traced_date ${JSON.stringify(bad)} must fail`);
  }
});

test('missing source fields fail', () => {
  for (const field of ['title', 'url', 'publisher', 'quote_or_summary']) {
    const dataset = mutateRow(0, { trace_sources: [makeStatuteSource({ [field]: '' })] });
    assert.ok(errorsOf(dataset).some((e) => e.includes(field)), `empty source ${field} must fail`);
  }
  const badType = mutateRow(0, { trace_sources: [makeStatuteSource({ source_type: 'blog' })] });
  assert.ok(errorsOf(badType).some((e) => e.includes('source_type')));
  const badProvision = mutateRow(0, { trace_sources: [makeStatuteSource({ provision: '' })] });
  assert.ok(errorsOf(badProvision).some((e) => e.includes('provision')));
  const badNotes = mutateRow(0, { trace_sources: [makeStatuteSource({ notes: 42 })] });
  assert.ok(errorsOf(badNotes).some((e) => e.includes('notes')));
});

// --- derived metadata ---

test('derived metadata comes from explicit trace_status, not the heuristic', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clause-dataset-'));
  const file = path.join(dir, 'ds.yaml');
  fs.writeFileSync(file, require('yaml').stringify(makeDataset()));
  try {
    const loaded = loadClauseDataset({ mode: 'dev', filePath: file });
    const byId = Object.fromEntries(loaded.rows.map((r) => [r.id, r]));
    assert.equal(byId['row-1'].isTraced, true);
    assert.equal(byId['row-1'].traceStatus, 'traced');
    assert.equal(byId['row-2'].isTraced, false);
    assert.equal(byId['row-2'].traceStatus, 'placeholder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('datasetMeta surfaces version info', () => {
  const meta = datasetMeta(makeDataset());
  assert.deepEqual(meta, {
    datasetVersion: 'test',
    schemaVersion: 2,
    created: undefined,
    status: 'test',
    rowCount: 2,
  });
});

// --- date-window behaviour (24) ---

test('row applies on the valid_from boundary', () => {
  const rows = makeDataset().rows;
  assert.ok(getApplicableRules(rows, '2026-01-01').some((r) => r.id === 'row-1'));
  assert.ok(!getApplicableRules(rows, '2025-12-31').some((r) => r.id === 'row-1'));
});

test('row applies on the valid_to boundary (2027-12-31 in-window)', () => {
  const rows = makeDataset().rows;
  assert.ok(getApplicableRules(rows, '2027-12-31').some((r) => r.id === 'row-1'));
});

test('row no longer applies the day after valid_to (2028-01-01 out)', () => {
  const rows = makeDataset().rows;
  assert.ok(!getApplicableRules(rows, '2028-01-01').some((r) => r.id === 'row-1'));
});

test('open-ended valid_to (null) stays applicable after valid_from', () => {
  const rows = makeDataset().rows;
  assert.ok(getApplicableRules(rows, '2099-01-01').some((r) => r.id === 'row-2'));
});

test('malformed evaluation date fails clearly', () => {
  const rows = makeDataset().rows;
  for (const bad of ['2026-13-01', 'today', '', null, undefined, new Date()]) {
    assert.throws(() => getApplicableRules(rows, bad), /evaluationDate/);
  }
});

test('getRowsByClauseType filters by clause_type', () => {
  const rows = makeDataset().rows;
  assert.deepEqual(getRowsByClauseType(rows, 'sublet').map((r) => r.id), ['row-2']);
  assert.deepEqual(getRowsByClauseType(rows, 'nope'), []);
});

// --- route/startup guard (25) ---

test('no route/startup/middleware code references the clause dataset', () => {
  const repoRoot = path.join(__dirname, '..');
  const productFacing = [
    'index.js',
    'db.js',
    'subscription.js',
    ...fs.readdirSync(path.join(repoRoot, 'routes')).map((f) => path.join('routes', f)),
    ...fs.readdirSync(path.join(repoRoot, 'middleware')).map((f) => path.join('middleware', f)),
    ...fs
      .readdirSync(path.join(repoRoot, 'lib'))
      .filter((f) => f !== 'clauseDataset.js')
      .map((f) => path.join('lib', f)),
  ];
  for (const rel of productFacing) {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(
      !/clauseDataset|clause-dataset|loadClauseDataset|getApplicableRules|trace_status|trace_sources/.test(content),
      `${rel} must not reference the clause dataset in T9A`
    );
  }
});

test('default dataset path points at the committed snapshot', () => {
  assert.ok(fs.existsSync(DEFAULT_DATASET_PATH));
  assert.ok(DEFAULT_DATASET_PATH.endsWith(path.join('data', 'clause-dataset.yaml')));
});
