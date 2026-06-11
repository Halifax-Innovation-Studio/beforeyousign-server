// Clause dataset loader / schema validation (T2).
// Internal infrastructure only: nothing here is wired into routes or server
// startup. Consumers must call loadClauseDataset() explicitly and pass a mode.
//
// Dataset snapshot: data/clause-dataset.yaml (copied from
// Signal-Intelligence/product/bys-clause-dataset-seed.yaml; see the
// provenance header in that file).

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULT_DATASET_PATH = path.join(__dirname, '..', 'data', 'clause-dataset.yaml');

const SUPPORTED_SCHEMA_VERSIONS = [1];
const MODES = ['shipping', 'dev', 'eval'];
const EXPECTED_FLAGS = ['ok', 'flag', 'missing', 'out-of-scope'];
const TO_TRACE_PREFIX = 'TO-TRACE';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Date-only validity check. Uses UTC round-tripping so local timezone can
// never shift a date; all comparisons elsewhere are lexicographic, which is
// chronologically correct for YYYY-MM-DD strings.
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isToTrace(statuteRef) {
  return typeof statuteRef === 'string' && statuteRef.trim().startsWith(TO_TRACE_PREFIX);
}

function assertMode(options) {
  const mode = options && options.mode;
  if (!MODES.includes(mode)) {
    throw new Error(
      `clauseDataset: mode is required and must be one of ${MODES.join(', ')} (got ${JSON.stringify(mode)})`
    );
  }
  return mode;
}

// Validates a parsed dataset object. Pure: returns { errors, warnings },
// never throws on dataset problems. Shipping mode escalates untraced rows
// (TO-TRACE statute_ref, unconfirmed valid_from) from warnings to errors.
function validateClauseDataset(dataset, options) {
  const mode = assertMode(options);
  const errors = [];
  const warnings = [];

  if (dataset === null || typeof dataset !== 'object' || Array.isArray(dataset)) {
    return { errors: ['dataset must be a mapping (object) at the top level'], warnings };
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(dataset.schema_version)) {
    errors.push(
      `unsupported schema_version ${JSON.stringify(dataset.schema_version)}; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`
    );
  }

  if (!Array.isArray(dataset.rows)) {
    errors.push('rows must be a list');
    return { errors, warnings };
  }
  if (dataset.rows.length === 0) {
    errors.push('rows must not be empty');
    return { errors, warnings };
  }
  if (typeof dataset.row_count === 'number' && dataset.row_count !== dataset.rows.length) {
    errors.push(`row_count is ${dataset.row_count} but rows has ${dataset.rows.length} entries`);
  }

  const seenIds = new Set();
  const untracedStatuteRows = [];
  const unconfirmedValidFromRows = [];

  dataset.rows.forEach((row, index) => {
    const label = isNonEmptyString(row && row.id) ? row.id : `rows[${index}]`;

    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${label}: row must be a mapping`);
      return;
    }

    if (!isNonEmptyString(row.id)) {
      errors.push(`${label}: id is required and must be a non-empty string`);
    } else if (seenIds.has(row.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      seenIds.add(row.id);
    }

    for (const field of ['clause_type', 'rule_summary', 'statute_ref']) {
      if (!isNonEmptyString(row[field])) {
        errors.push(`${label}: ${field} is required and must be a non-empty string`);
      }
    }

    const source = row.source;
    const sourceOk =
      isNonEmptyString(source) ||
      (source !== null && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length > 0);
    if (!sourceOk) {
      errors.push(`${label}: source is required and must be a non-empty string or mapping`);
    }

    // valid_from: a date, or null meaning "to confirm during trace" (seed
    // fields_doc). Null is a placeholder like TO-TRACE: tolerated in dev/eval,
    // refused in shipping.
    if (row.valid_from === null || row.valid_from === undefined) {
      unconfirmedValidFromRows.push(label);
    } else if (!isValidDateOnly(row.valid_from)) {
      errors.push(`${label}: valid_from must be a YYYY-MM-DD date (got ${JSON.stringify(row.valid_from)})`);
    }

    // valid_to: a date, or null meaning in force with no known end date.
    if (row.valid_to !== null && row.valid_to !== undefined) {
      if (!isValidDateOnly(row.valid_to)) {
        errors.push(`${label}: valid_to must be a YYYY-MM-DD date or null (got ${JSON.stringify(row.valid_to)})`);
      } else if (isValidDateOnly(row.valid_from) && row.valid_to < row.valid_from) {
        errors.push(`${label}: valid_to (${row.valid_to}) is before valid_from (${row.valid_from})`);
      }
    }

    if (!EXPECTED_FLAGS.includes(row.expected_flag)) {
      errors.push(
        `${label}: expected_flag must be one of ${EXPECTED_FLAGS.join(', ')} (got ${JSON.stringify(row.expected_flag)})`
      );
    }

    const points = row.expected_explanation_points;
    if (!Array.isArray(points) || points.length === 0) {
      errors.push(`${label}: expected_explanation_points must be a non-empty list`);
    } else if (!points.every(isNonEmptyString)) {
      errors.push(`${label}: expected_explanation_points entries must all be non-empty strings`);
    }

    if (isToTrace(row.statute_ref)) {
      untracedStatuteRows.push(label);
    }
  });

  if (untracedStatuteRows.length > 0) {
    const message = `statute_ref is a TO-TRACE placeholder (untraced) on rows: ${untracedStatuteRows.join(', ')}`;
    if (mode === 'shipping') {
      errors.push(`shipping mode refuses untraced rules — ${message}`);
    } else {
      warnings.push(message);
    }
  }
  if (unconfirmedValidFromRows.length > 0) {
    const message = `valid_from is unconfirmed (null, to confirm during trace) on rows: ${unconfirmedValidFromRows.join(', ')}`;
    if (mode === 'shipping') {
      errors.push(`shipping mode refuses rules without a confirmed effective date — ${message}`);
    } else {
      warnings.push(message);
    }
  }

  return { errors, warnings };
}

// Derived per-row trace metadata so downstream code can refuse untraced rules
// without re-implementing the placeholder convention.
function deriveRowMeta(row) {
  const traced = !isToTrace(row.statute_ref) && row.valid_from !== null && row.valid_from !== undefined;
  return {
    ...row,
    isTraced: traced,
    traceStatus: traced ? 'traced' : 'placeholder',
  };
}

function datasetMeta(dataset) {
  if (dataset === null || typeof dataset !== 'object') {
    throw new Error('clauseDataset: datasetMeta requires a parsed dataset object');
  }
  return {
    datasetVersion: dataset.dataset_version,
    schemaVersion: dataset.schema_version,
    created: dataset.created,
    status: dataset.status,
    rowCount: Array.isArray(dataset.rows) ? dataset.rows.length : 0,
  };
}

// Explicit-call loader: parse, validate, derive trace metadata. Throws with
// every validation error aggregated. Never called at server startup in T2.
function loadClauseDataset(options) {
  const mode = assertMode(options);
  const filePath = (options && options.filePath) || DEFAULT_DATASET_PATH;

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`clauseDataset: failed to parse ${filePath}: ${err.message}`);
  }

  const { errors, warnings } = validateClauseDataset(parsed, { mode });
  if (errors.length > 0) {
    throw new Error(`clauseDataset: validation failed (mode=${mode}):\n- ${errors.join('\n- ')}`);
  }

  return {
    meta: datasetMeta(parsed),
    rows: parsed.rows.map(deriveRowMeta),
    warnings,
    mode,
  };
}

// Date-window selection. evaluationDate is a YYYY-MM-DD string; comparisons
// are lexicographic (timezone-proof for date-only strings). Boundaries are
// inclusive: a row applies on valid_from and on valid_to. Null valid_to is
// open-ended; null valid_from (unconfirmed) does not restrict the window —
// shipping-mode validation already refuses such rows.
function getApplicableRules(rows, evaluationDate) {
  if (!Array.isArray(rows)) {
    throw new Error('clauseDataset: getApplicableRules requires an array of rows');
  }
  if (!isValidDateOnly(evaluationDate)) {
    throw new Error(
      `clauseDataset: evaluationDate must be a valid YYYY-MM-DD date (got ${JSON.stringify(evaluationDate)})`
    );
  }
  return rows.filter((row) => {
    if (isValidDateOnly(row.valid_from) && evaluationDate < row.valid_from) return false;
    if (isValidDateOnly(row.valid_to) && evaluationDate > row.valid_to) return false;
    return true;
  });
}

function getRowsByClauseType(rows, clauseType) {
  if (!Array.isArray(rows)) {
    throw new Error('clauseDataset: getRowsByClauseType requires an array of rows');
  }
  return rows.filter((row) => row.clause_type === clauseType);
}

module.exports = {
  loadClauseDataset,
  validateClauseDataset,
  getApplicableRules,
  getRowsByClauseType,
  datasetMeta,
  // exported for tests
  DEFAULT_DATASET_PATH,
  SUPPORTED_SCHEMA_VERSIONS,
  EXPECTED_FLAGS,
  MODES,
};
