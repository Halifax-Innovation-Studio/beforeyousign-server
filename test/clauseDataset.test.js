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

// Minimal fully-traced valid dataset for mutation tests.
function makeDataset(overrides = {}) {
  return {
    dataset_version: 'test',
    schema_version: 1,
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
      },
      {
        id: 'row-2',
        clause_type: 'sublet',
        rule_summary: 'Subtenant rent may not exceed lease rent.',
        statute_ref: 'RTA s.6',
        source: 'test source',
        valid_from: '2024-09-20',
        valid_to: null,
        expected_flag: 'flag',
        expected_explanation_points: ['sublet rent above lease rent not permitted'],
      },
    ],
    ...overrides,
  };
}

function mutateFirstRow(mutation) {
  const dataset = makeDataset();
  Object.assign(dataset.rows[0], mutation);
  return dataset;
}

function errorsOf(dataset, mode = 'dev') {
  return validateClauseDataset(dataset, { mode }).errors;
}

// 1. Seed file loads in dev/eval mode.
test('seed snapshot loads in dev mode with placeholder warnings', () => {
  const loaded = loadClauseDataset({ mode: 'dev' });
  assert.equal(loaded.meta.schemaVersion, 1);
  assert.equal(loaded.meta.rowCount, 7);
  assert.equal(loaded.rows.length, 7);
  assert.ok(loaded.warnings.length > 0, 'seed TO-TRACE placeholders must surface as warnings');
  assert.ok(loaded.rows.every((row) => row.isTraced === false));
  assert.ok(loaded.rows.every((row) => row.traceStatus === 'placeholder'));
});

test('seed snapshot loads in eval mode', () => {
  const loaded = loadClauseDataset({ mode: 'eval' });
  assert.equal(loaded.rows.length, 7);
});

// 16. TO-TRACE fails in shipping mode, reporting all offending row IDs.
test('seed snapshot is refused in shipping mode and names every untraced row', () => {
  assert.throws(
    () => loadClauseDataset({ mode: 'shipping' }),
    (err) => {
      for (const id of ['rc-001', 'rc-002', 'lp-001', 'sl-001', 'es-001', 'cc-001', 'cc-002']) {
        assert.ok(err.message.includes(id), `error should name ${id}`);
      }
      return true;
    }
  );
});

// 17. TO-TRACE allowed only in explicit dev/eval mode; mode is mandatory.
test('mode is required and must be shipping, dev, or eval', () => {
  assert.throws(() => loadClauseDataset(), /mode is required/);
  assert.throws(() => loadClauseDataset({ mode: 'production' }), /mode is required/);
  assert.throws(() => validateClauseDataset(makeDataset(), {}), /mode is required/);
});

test('TO-TRACE rows pass dev/eval validation with a warning, never silently', () => {
  const dataset = mutateFirstRow({ statute_ref: 'TO-TRACE (RTA)' });
  for (const mode of ['dev', 'eval']) {
    const { errors, warnings } = validateClauseDataset(dataset, { mode });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes('row-1')), `${mode} mode must warn about row-1`);
  }
  const shipping = validateClauseDataset(dataset, { mode: 'shipping' });
  assert.ok(shipping.errors.some((e) => e.includes('TO-TRACE') && e.includes('row-1')));
});

test('unconfirmed (null) valid_from is a warning in dev/eval and an error in shipping', () => {
  const dataset = mutateFirstRow({ valid_from: null });
  assert.deepEqual(errorsOf(dataset, 'dev'), []);
  assert.ok(errorsOf(dataset, 'shipping').some((e) => e.includes('row-1')));
});

// 2. Empty dataset fails.
test('empty rows list fails', () => {
  assert.ok(errorsOf(makeDataset({ rows: [] })).some((e) => e.includes('must not be empty')));
});

// 3. Missing top-level row list fails.
test('missing rows list fails', () => {
  const dataset = makeDataset();
  delete dataset.rows;
  assert.ok(errorsOf(dataset).some((e) => e.includes('rows must be a list')));
});

// 4. Unsupported schema_version fails.
test('unsupported schema_version fails', () => {
  assert.ok(errorsOf(makeDataset({ schema_version: 2 })).some((e) => e.includes('unsupported schema_version')));
  assert.ok(errorsOf(makeDataset({ schema_version: undefined })).some((e) => e.includes('unsupported schema_version')));
});

// 5. Duplicate IDs fail.
test('duplicate row ids fail', () => {
  const dataset = makeDataset();
  dataset.rows[1].id = 'row-1';
  assert.ok(errorsOf(dataset).some((e) => e.includes('duplicate id')));
});

// 6. Missing required field fails.
test('missing required fields fail', () => {
  for (const field of ['id', 'clause_type', 'rule_summary', 'statute_ref', 'source']) {
    const dataset = mutateFirstRow({ [field]: undefined });
    assert.ok(
      errorsOf(dataset).some((e) => e.includes(field)),
      `missing ${field} must produce an error naming it`
    );
  }
  assert.ok(errorsOf(mutateFirstRow({ rule_summary: '   ' })).some((e) => e.includes('rule_summary')));
});

// 7. Bad expected_flag fails.
test('invalid expected_flag fails', () => {
  assert.ok(errorsOf(mutateFirstRow({ expected_flag: 'warn' })).some((e) => e.includes('expected_flag')));
});

// 8. Bad date format fails.
test('malformed dates fail', () => {
  for (const bad of ['2026/01/01', '01-01-2026', '2026-13-01', '2026-02-30', '2026-1-1', 20260101]) {
    assert.ok(
      errorsOf(mutateFirstRow({ valid_from: bad })).some((e) => e.includes('valid_from')),
      `valid_from ${JSON.stringify(bad)} must fail`
    );
  }
  assert.ok(errorsOf(mutateFirstRow({ valid_to: '2027-00-10' })).some((e) => e.includes('valid_to')));
});

// 9. valid_to before valid_from fails.
test('valid_to before valid_from fails', () => {
  const dataset = mutateFirstRow({ valid_from: '2026-06-01', valid_to: '2026-05-31' });
  assert.ok(errorsOf(dataset).some((e) => e.includes('before valid_from')));
});

// 10–11. explanation points must be a non-empty list of non-empty strings.
test('empty expected_explanation_points fails', () => {
  assert.ok(
    errorsOf(mutateFirstRow({ expected_explanation_points: [] })).some((e) =>
      e.includes('expected_explanation_points')
    )
  );
});

test('empty string inside expected_explanation_points fails', () => {
  assert.ok(
    errorsOf(mutateFirstRow({ expected_explanation_points: ['fine', '  '] })).some((e) =>
      e.includes('expected_explanation_points')
    )
  );
});

// 12–15. Date-window boundaries (ticket acceptance: 2027-12-31 in, 2028-01-01 out).
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

test('datasetMeta surfaces version info', () => {
  const meta = datasetMeta(makeDataset());
  assert.deepEqual(meta, {
    datasetVersion: 'test',
    schemaVersion: 1,
    created: undefined,
    status: 'test',
    rowCount: 2,
  });
});

test('row_count mismatch with rows length fails', () => {
  assert.ok(errorsOf(makeDataset({ row_count: 5 })).some((e) => e.includes('row_count')));
});

test('derived trace metadata distinguishes traced from placeholder rows', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clause-dataset-'));
  const file = path.join(dir, 'ds.yaml');
  const dataset = makeDataset();
  dataset.rows[1].statute_ref = 'TO-TRACE (RTA)';
  fs.writeFileSync(file, require('yaml').stringify(dataset));
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

// 18. No product-facing route or startup code imports or serves the dataset.
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
      !/clauseDataset|clause-dataset|loadClauseDataset|getApplicableRules/.test(content),
      `${rel} must not reference the clause dataset in T2`
    );
  }
});

test('default dataset path points at the committed snapshot', () => {
  assert.ok(fs.existsSync(DEFAULT_DATASET_PATH));
  assert.ok(DEFAULT_DATASET_PATH.endsWith(path.join('data', 'clause-dataset.yaml')));
});
