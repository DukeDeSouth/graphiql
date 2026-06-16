import {
  GraphQLList,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLInputType,
  type GraphQLType,
} from 'graphql';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  argValueToValueNode,
  valueNodeToArgValue,
  type ArgValue,
} from '../lib/document-mutator';

type ArgInputProps = {
  arg: GraphQLArgument | GraphQLInputField;
  value: ArgValue;
  onChange: (v: ArgValue) => void;
  /** When set, a "use as variable" toggle is rendered for scalar/enum args. */
  isVariable?: boolean;
  /** The variable name currently bound to this arg (only meaningful when `isVariable` is true). */
  variableName?: string;
  /** Called when the user clicks "use as variable". */
  onPromote?: (argName: string, suggestedName: string) => void;
  /** Called when the user clicks the active variable badge to demote back to a literal. */
  onDemote?: (varName: string) => void;
};

/**
 * Renders an appropriate input control for a single GraphQL argument or input
 * field. Handles scalars, enums, lists (repeat add/remove UI), and input
 * objects (recursive nested fields via a collapsible disclosure). Returns null
 * for any types not yet supported.
 *
 * When `onPromote` is supplied, scalar and enum inputs show a "use as variable"
 * toggle button. Clicking it calls `onPromote`; when `isVariable` is true the
 * button shows the bound variable name and clicking it calls `onDemote`.
 */
export const ArgInput: FC<ArgInputProps> = ({
  arg,
  value,
  onChange,
  isVariable = false,
  variableName,
  onPromote,
  onDemote,
}) => {
  return (
    <ArgInputByType
      type={arg.type}
      name={arg.name}
      value={value}
      onChange={onChange}
      isVariable={isVariable}
      variableName={variableName}
      onPromote={onPromote}
      onDemote={onDemote}
    />
  );
};

// ---------------------------------------------------------------------------
// Internal: dispatch by runtime type (handles NonNull unwrapping)
// ---------------------------------------------------------------------------

type TypedInputProps = {
  type: GraphQLType;
  name: string;
  value: ArgValue;
  onChange: (v: ArgValue) => void;
  isVariable?: boolean;
  variableName?: string;
  onPromote?: (argName: string, suggestedName: string) => void;
  onDemote?: (varName: string) => void;
};

const ArgInputByType: FC<TypedInputProps> = ({
  type,
  name,
  value,
  onChange,
  isVariable = false,
  variableName,
  onPromote,
  onDemote,
}) => {
  // Strip NonNull wrapper transparently
  if (isNonNullType(type)) {
    return (
      <ArgInputByType
        type={type.ofType}
        name={name}
        value={value}
        onChange={onChange}
        isVariable={isVariable}
        variableName={variableName}
        onPromote={onPromote}
        onDemote={onDemote}
      />
    );
  }

  if (isListType(type)) {
    return (
      <ListArgInput
        itemType={type.ofType}
        name={name}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
      />
    );
  }

  const named = getNamedType(type);

  if (isInputObjectType(named)) {
    const objValue =
      !Array.isArray(value) && typeof value === 'object' && value !== null
        ? (value as { [field: string]: ArgValue })
        : {};
    return (
      <InputObjectArgInput
        inputType={named}
        name={name}
        value={objValue}
        onChange={onChange}
      />
    );
  }

  // For scalar and enum types, optionally render the variable toggle.
  const toggleBtn = onPromote ? (
    <button
      type="button"
      className="graphiql-qb-var-toggle"
      aria-pressed={isVariable}
      onClick={() => {
        if (isVariable && onDemote && variableName) {
          onDemote(variableName);
        } else {
          onPromote(name, name);
        }
      }}
    >
      {isVariable && variableName ? `$${variableName}` : 'Use as variable'}
    </button>
  ) : null;

  if (isEnumType(named)) {
    return (
      <span className="graphiql-qb-arg-with-toggle">
        {isVariable ? (
          <span
            className="graphiql-qb-var-badge"
            aria-label={`${name} bound to $${variableName ?? name}`}
          >
            ${variableName ?? name}
          </span>
        ) : (
          <EnumArgControl
            name={name}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
            enumValues={named.getValues().map(v => v.name)}
          />
        )}
        {toggleBtn}
      </span>
    );
  }

  if (isScalarType(named)) {
    if (named.name === 'Boolean') {
      return (
        <span className="graphiql-qb-arg-with-toggle">
          {isVariable ? (
            <span
              className="graphiql-qb-var-badge"
              aria-label={`${name} bound to $${variableName ?? name}`}
            >
              ${variableName ?? name}
            </span>
          ) : (
            <BooleanArgControl
              name={name}
              value={typeof value === 'string' ? value : ''}
              onChange={onChange}
            />
          )}
          {toggleBtn}
        </span>
      );
    }
    const inputType =
      named.name === 'Int' || named.name === 'Float' ? 'number' : 'text';
    return (
      <span className="graphiql-qb-arg-with-toggle">
        {isVariable ? (
          <span
            className="graphiql-qb-var-badge"
            aria-label={`${name} bound to $${variableName ?? name}`}
          >
            ${variableName ?? name}
          </span>
        ) : (
          <ScalarArgControl
            name={name}
            inputType={inputType}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
          />
        )}
        {toggleBtn}
      </span>
    );
  }

  return null;
};

// ---------------------------------------------------------------------------
// ScalarArgControl — local state + reconciliation for text/number inputs
// ---------------------------------------------------------------------------
//
// Reconciliation rule:
//   - Keep a local `localValue` state seeded from `value` prop.
//   - Track the last value emitted via `lastEmitted` ref.
//   - On render: if `value` differs from both `localValue` AND `lastEmitted`,
//     treat it as an external change and sync local state to `value`.
//     If `value` equals `lastEmitted` it's just our own change echoing back —
//     don't clobber local (that would drop in-progress typing).
//   - On user input: update local state immediately, set `lastEmitted`, call
//     `onChange(newValue)`.
//
// This lets characters accumulate locally across keystrokes while the document
// round-trip (parse→print→editor→re-parse) catches up asynchronously.

type ScalarArgControlProps = {
  name: string;
  inputType: 'text' | 'number';
  value: string;
  onChange: (v: ArgValue) => void;
};

const ScalarArgControl: FC<ScalarArgControlProps> = ({
  name,
  inputType,
  value,
  onChange,
}) => {
  const [localValue, setLocalValue] = useState(value);
  // Track the last value this component emitted so we can distinguish our own
  // changes echoing back from genuine external document changes.
  const lastEmitted = useRef(value);

  // Reconcile: if the incoming prop differs from what we last emitted, it's an
  // external change (e.g. the user edited the editor directly) — sync local state.
  // If it matches what we emitted, it's just our own write echoing back — leave
  // local state alone so in-progress typing accumulates correctly.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      setLocalValue(value);
      lastEmitted.current = value;
    }
  }, [value]);

  const handleChange = (newValue: string) => {
    setLocalValue(newValue);
    lastEmitted.current = newValue;
    onChange(newValue);
  };

  return (
    <input
      type={inputType}
      aria-label={name}
      value={localValue}
      onChange={e => handleChange(e.target.value)}
      className="graphiql-qb-arg-input"
    />
  );
};

// ---------------------------------------------------------------------------
// BooleanArgControl — checkbox (no multi-char issue, but keep pattern uniform)
// ---------------------------------------------------------------------------

type BooleanArgControlProps = {
  name: string;
  value: string;
  onChange: (v: ArgValue) => void;
};

const BooleanArgControl: FC<BooleanArgControlProps> = ({
  name,
  value,
  onChange,
}) => {
  return (
    <input
      type="checkbox"
      aria-label={name}
      checked={value === 'true'}
      onChange={e => onChange(e.target.checked ? 'true' : 'false')}
      className="graphiql-qb-arg-checkbox"
    />
  );
};

// ---------------------------------------------------------------------------
// EnumArgControl — select (no multi-char issue, but extracted for symmetry)
// ---------------------------------------------------------------------------

type EnumArgControlProps = {
  name: string;
  value: string;
  onChange: (v: ArgValue) => void;
  enumValues: string[];
};

const EnumArgControl: FC<EnumArgControlProps> = ({
  name,
  value,
  onChange,
  enumValues,
}) => {
  return (
    <select
      aria-label={name}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="graphiql-qb-arg-select"
    >
      <option value="">—</option>
      {enumValues.map(v => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
};

// ---------------------------------------------------------------------------
// List arg: local items array with reconciliation so empty items persist
// ---------------------------------------------------------------------------
//
// The same reconciliation pattern as ScalarArgControl, but for arrays:
//   - Keep `localItems` local state seeded from `value` prop.
//   - Track the last array emitted via `lastEmitted` ref.
//   - On render: if prop `value` differs from both `localItems` AND
//     `lastEmitted` (by reference-equality of their serialized form), treat
//     it as an external change and sync.
//   - On Add/Remove/Update: update local state immediately, set `lastEmitted`,
//     call `onChange(newArray)`.
//
// This ensures an added empty item stays visible even though the document
// round-trip omits empty leaves (because `argValueToValueNode` skips them).

type ListArgInputProps = {
  itemType: GraphQLType;
  name: string;
  value: ArgValue[];
  onChange: (v: ArgValue) => void;
};

// Stable identity key for reconciliation comparison (JSON is fine for ArgValue).
function serializeItems(items: ArgValue[]): string {
  return JSON.stringify(items);
}

const ListArgInput: FC<ListArgInputProps> = ({
  itemType,
  name,
  value,
  onChange,
}) => {
  const [localItems, setLocalItems] = useState<ArgValue[]>(value);
  // Track the last serialized value emitted so we can distinguish our own
  // changes echoing back from genuine external document changes.
  const lastEmitted = useRef<string>(serializeItems(value));

  // Reconcile: if the incoming prop differs from what we last emitted, treat it
  // as an external change and sync. If it matches what we emitted, it's just
  // our write echoing back — leave local state alone so added empty items persist.
  useEffect(() => {
    const serializedProp = serializeItems(value);
    if (serializedProp !== lastEmitted.current) {
      setLocalItems(value);
      lastEmitted.current = serializedProp;
    }
  }, [value]);

  const emit = (next: ArgValue[]) => {
    setLocalItems(next);
    // Store the NORMALIZED form (what the document will echo back) so that the
    // echo re-render doesn't look like an external change. Empty scalar leaves
    // are dropped by argValueToValueNode, so [''] normalizes to [] for a list
    // of Int/String/etc. Without this, the echo would clobber local state and
    // remove a just-added empty item before the user can type into it.
    const listType = new GraphQLList(itemType as GraphQLInputType);
    const roundTripped = argValueToValueNode(listType, next);
    const normalizedItems = roundTripped
      ? (valueNodeToArgValue(roundTripped) as ArgValue[])
      : [];
    lastEmitted.current = serializeItems(normalizedItems);
    onChange(next);
  };

  const updateAt = (index: number, newVal: ArgValue) => {
    const next = [...localItems];
    next[index] = newVal;
    emit(next);
  };

  const removeAt = (index: number) => {
    emit(localItems.filter((_, i) => i !== index));
  };

  const addItem = () => {
    emit([...localItems, defaultValueForType(itemType)]);
  };

  return (
    <div className="graphiql-qb-list-arg">
      {localItems.map((item, i) => (
        <div key={i} className="graphiql-qb-list-item">
          <ArgInputByType
            type={itemType}
            name={name}
            value={item}
            onChange={v => updateAt(i, v)}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label="Remove item"
            className="graphiql-qb-list-remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        aria-label="Add item"
        className="graphiql-qb-list-add"
      >
        + Add
      </button>
    </div>
  );
};

function defaultValueForType(type: GraphQLType): ArgValue {
  if (isNonNullType(type)) {
    return defaultValueForType(type.ofType);
  }
  if (isListType(type)) {
    return [];
  }
  const named = getNamedType(type);
  if (isInputObjectType(named)) {
    return {};
  }
  return '';
}

// ---------------------------------------------------------------------------
// Input object arg: real { [field]: ArgValue } — no JSON round-trips
// ---------------------------------------------------------------------------

type InputObjectArgInputProps = {
  inputType: ReturnType<typeof getNamedType> & {
    getFields: () => Record<string, GraphQLInputField>;
  };
  name: string;
  value: { [field: string]: ArgValue };
  onChange: (v: ArgValue) => void;
};

const InputObjectArgInput: FC<InputObjectArgInputProps> = ({
  inputType,
  name,
  value,
  onChange,
}) => {
  // Render nested fields only once expanded. Input object types can be
  // self-referential (e.g. an input with a field of its own type), so rendering
  // every level eagerly would recurse forever.
  const [open, setOpen] = useState(false);
  const fields = inputType.getFields();

  const onChangeField = (fieldName: string, fieldValue: ArgValue) => {
    const next: { [field: string]: ArgValue } = { ...value };
    if (fieldValue === '' || fieldValue === undefined) {
      delete next[fieldName];
    } else {
      next[fieldName] = fieldValue;
    }
    onChange(next);
  };

  return (
    <details
      className="graphiql-qb-input-object"
      onToggle={e => setOpen(e.currentTarget.open)}
    >
      <summary>{name}</summary>
      {open &&
        Object.entries(fields).map(([fieldName, field]) => {
          const fieldVal: ArgValue = value[fieldName] ?? '';
          return (
            <div key={fieldName} className="graphiql-qb-input-field">
              <ArgInputByType
                type={field.type}
                name={fieldName}
                value={fieldVal}
                onChange={v => onChangeField(fieldName, v)}
              />
            </div>
          );
        })}
    </details>
  );
};
