// Clause dataset loader / schema validation (T2, migrated to schema v2 in T9A
// per Signal-Intelligence/product/bys-t9-statute-trace-plan.md §5).
// Internal infrastructure only: nothing here is wired into routes or server
// startup. Consumers must call loadClauseDataset() explicitly and pass a mode.
//
// Dataset snapshot: data/clause-dataset.yaml (copied from
// Signal-Intelligence/product/bys-clause-dataset-seed.yaml; see the
// provenance header and migration log in that file).

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULT_DATASET_PATH = path.join(__dirname, '..', 'data', 'clause-dataset.yaml');

const SUPPORTED_SCHEMA_VERSIONS = [2];
const MODES = ['shipping', 'dev', 'eval'];
const EXPECTED_FLAGS = ['ok', 'flag', 'missing', 'out-of-scope'];
const TRACE_STATUSES = ['placeholder', 'partial', 'traced', 'unresolved'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];
const SOURCE_TYPES = ['statute', 'regulation', 'amending-act', 'program-page', 'form-guide', 'locator'];
// Source types that count as official trace authority (T9 plan §3/§5);
// program pages, form guides, and locators are corroboration only.
const OFFICIAL_SOURCE_TYPES = ['statute', 'regulation', 'amending-act'];
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

function isNullish(value) {
  return value === null || value === undefined;
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

// Validates one trace_sources entry. Returns error strings prefixed with the
// row label and source index.
function validateTraceSource(entry, label, index) {
  const errors = [];
  const where = `${label}.trace_sources[${index}]`;

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${where}: must be a mapping`];
  }
  if (!SOURCE_TYPES.includes(entry.source_type)) {
    errors.push(`${where}: source_type must be one of ${SOURCE_TYPES.join(', ')} (got ${JSON.stringify(entry.source_type)})`);
  }
  for (const field of ['title', 'url', 'publisher', 'quote_or_summary']) {
    if (!isNonEmptyString(entry[field])) {
      errors.push(`${where}: ${field} is required and must be a non-empty string`);
    }
  }
  if (!isValidDateOnly(entry.retrieved_date)) {
    errors.push(`${where}: retrieved_date must be a YYYY-MM-DD date (got ${JSON.stringify(entry.retrieved_date)})`);
  }
  if (!isNullish(entry.provision) && !isNonEmptyString(entry.provision)) {
    errors.push(`${where}: provision must be a non-empty string or null`);
  }
  if (!isNullish(entry.notes) && typeof entry.notes !== 'string') {
    errors.push(`${where}: notes must be a string or null`);
  }
  return errors;
}

// Per-status trace rules (T9 plan §5; approval record ruling 1). These are
// consistency rules and fail validation in EVERY mode — a row claiming
// "traced" while still carrying a TO-TRACE statute_ref or a null valid_from
// is a data error, not a mode concern.
function validateTraceFields(row, label) {
  const errors = [];
  const warnings = [];

  if (!TRACE_STATUSES.includes(row.trace_status)) {
    errors.push(
      `${label}: trace_status is required and must be one of ${TRACE_STATUSES.join(', ')} (got ${JSON.stringify(row.trace_status)})`
    );
    return { errors, warnings };
  }

  const sources = row.trace_sources;
  const sourcesIsList = Array.isArray(sources);
  if (!isNullish(sources) && !sourcesIsList) {
    errors.push(`${label}: trace_sources must be a list`);
  }
  if (sourcesIsList) {
    sources.forEach((entry, index) => errors.push(...validateTraceSource(entry, label, index)));
  }
  const sourceCount = sourcesIsList ? sources.length : 0;
  const hasOfficialSource =
    sourcesIsList && sources.some((entry) => entry && OFFICIAL_SOURCE_TYPES.includes(entry.source_type));

  switch (row.trace_status) {
    case 'placeholder':
      if (!isToTrace(row.statute_ref)) {
        errors.push(`${label}: placeholder rows must keep a ${TO_TRACE_PREFIX} statute_ref`);
      }
      if (!isNullish(row.confidence)) {
        errors.push(`${label}: placeholder rows must have confidence: null (got ${JSON.stringify(row.confidence)})`);
      }
      if (sourceCount > 0) {
        errors.push(`${label}: placeholder rows must have an empty trace_sources list`);
      }
      if (!isNullish(row.traced_date)) {
        errors.push(`${label}: placeholder rows must have traced_date: null (got ${JSON.stringify(row.traced_date)})`);
      }
      break;

    case 'unresolved':
      if (!isToTrace(row.statute_ref)) {
        warnings.push(`${label}: unresolved rows should keep a ${TO_TRACE_PREFIX} statute_ref`);
      }
      if (!['low', 'medium'].includes(row.confidence)) {
        errors.push(`${label}: unresolved rows require confidence low or medium (got ${JSON.stringify(row.confidence)})`);
      }
      if (!isValidDateOnly(row.traced_date)) {
        errors.push(`${label}: unresolved rows require a YYYY-MM-DD traced_date (got ${JSON.stringify(row.traced_date)})`);
      }
      break;

    case 'partial':
      if (!['low', 'medium'].includes(row.confidence)) {
        errors.push(`${label}: partial rows require confidence low or medium (got ${JSON.stringify(row.confidence)})`);
      }
      if (sourceCount === 0) {
        errors.push(`${label}: partial rows require at least one trace_sources entry`);
      }
      if (!isValidDateOnly(row.traced_date)) {
        errors.push(`${label}: partial rows require a YYYY-MM-DD traced_date (got ${JSON.stringify(row.traced_date)})`);
      }
      break;

    case 'traced':
      if (row.confidence !== 'high') {
        errors.push(`${label}: traced rows require confidence high (got ${JSON.stringify(row.confidence)})`);
      }
      if (!hasOfficialSource) {
        errors.push(
          `${label}: traced rows require at least one official source (source_type ${OFFICIAL_SOURCE_TYPES.join(', ')})`
        );
      }
      if (!isValidDateOnly(row.traced_date)) {
        errors.push(`${label}: traced rows require a YYYY-MM-DD traced_date (got ${JSON.stringify(row.traced_date)})`);
      }
      if (isToTrace(row.statute_ref)) {
        errors.push(`${label}: traced rows must not have a ${TO_TRACE_PREFIX} statute_ref`);
      }
      if (isNullish(row.valid_from)) {
        errors.push(`${label}: traced rows must have a confirmed valid_from date`);
      }
      break;
  }

  return { errors, warnings };
}

// Validates a parsed dataset object. Pure: returns { errors, warnings },
// never throws on dataset problems. Trace consistency rules fail in every
// mode; shipping mode additionally refuses every row that is not fully
// traced (trace_status !== 'traced') and every unconfirmed valid_from.
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
  const notTracedRows = [];
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
    // fields_doc). Null is tolerated in dev/eval, refused in shipping;
    // traced rows additionally require it in every mode (see trace rules).
    if (isNullish(row.valid_from)) {
      unconfirmedValidFromRows.push(label);
    } else if (!isValidDateOnly(row.valid_from)) {
      errors.push(`${label}: valid_from must be a YYYY-MM-DD date (got ${JSON.stringify(row.valid_from)})`);
    }

    // valid_to: a date, or null meaning in force with no known end date.
    if (!isNullish(row.valid_to)) {
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

    const trace = validateTraceFields(row, label);
    errors.push(...trace.errors);
    warnings.push(...trace.warnings);

    if (row.trace_status !== 'traced') {
      notTracedRows.push(label);
    }
  });

  if (notTracedRows.length > 0) {
    const message = `rows not fully traced (trace_status !== traced): ${notTracedRows.join(', ')}`;
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

// Derived per-row trace metadata so downstream code can refuse untraced
// rules. As of schema v2 this comes from the explicit, authoritative
// trace_status field — never from the old TO-TRACE heuristic (which lives
// on only as a consistency check inside validation).
function deriveRowMeta(row) {
  return {
    ...row,
    isTraced: row.trace_status === 'traced',
    traceStatus: row.trace_status,
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
// every validation error aggregated. Never called at server startup.
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
  TRACE_STATUSES,
  CONFIDENCE_LEVELS,
  SOURCE_TYPES,
  OFFICIAL_SOURCE_TYPES,
};
