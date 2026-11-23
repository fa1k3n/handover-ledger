// The schema check: a walker of our own over the JSON Schema files in schema/, the twin of src/ledger/schema.ts (#140).
//
// The schema files stay the only source: they are embedded, read once, and walked. The walker knows the keywords the
// schema uses and refuses any other when it reads a schema, so a change to the schema cannot pass silently.
// It gives the faults ajv gives (allErrors), in ajv's order, with the words src/ledger/schema.ts makes of them.
// @code_class evidence
use crate::ledger::pattern::Pattern;
use crate::ledger::time::is_real_time;
use serde_json::{Map, Value};
use std::sync::OnceLock;

const EVENT_SCHEMA: &str = include_str!("../../../schema/event.v0.schema.json");
const LINE_SCHEMA: &str = include_str!("../../../schema/line.v0.schema.json");

/// The keywords the walker knows. Any other in a schema is refused.
const KNOWN: [&str; 19] = [
    "$schema",
    "$id",
    "title",
    "description",
    "$defs",
    "$ref",
    "type",
    "const",
    "enum",
    "not",
    "if",
    "then",
    "minLength",
    "maxLength",
    "pattern",
    "required",
    "additionalProperties",
    "properties",
    "dependentRequired",
];

/// The types of JSON Schema, by the name a schema gives them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Type {
    Null,
    Boolean,
    Object,
    Array,
    Number,
    Integer,
    String,
}

impl Type {
    fn named(name: &str) -> Option<Type> {
        Some(match name {
            "null" => Type::Null,
            "boolean" => Type::Boolean,
            "object" => Type::Object,
            "array" => Type::Array,
            "number" => Type::Number,
            "integer" => Type::Integer,
            "string" => Type::String,
            _ => return None,
        })
    }

    fn holds(self, value: &Value) -> bool {
        match self {
            Type::Null => value.is_null(),
            Type::Boolean => value.is_boolean(),
            Type::Object => value.is_object(),
            Type::Array => value.is_array(),
            Type::Number => value.is_number(),
            Type::Integer => value.as_f64().is_some_and(|n| n.fract() == 0.0),
            Type::String => value.is_string(),
        }
    }
}

/// A schema, read once.
#[derive(Debug, Clone)]
pub struct Schema {
    root: Node,
}

/// One schema of the tree, with its keywords read.
#[derive(Debug, Clone, Default)]
struct Node {
    /// `#`, `#/properties/source` …: where it stands, which only the `not` of the event's root needs.
    path: String,
    /// A boolean schema.
    always: Option<bool>,
    types: Vec<(String, Type)>,
    reference: Option<Box<Node>>,
    constant: Option<Value>,
    allowed: Option<Vec<Value>>,
    not: Option<Box<Node>>,
    when: Option<Box<Node>>,
    then: Option<Box<Node>>,
    max_length: Option<u64>,
    min_length: Option<u64>,
    pattern: Option<(String, Pattern)>,
    required: Vec<String>,
    additional: Option<Box<Node>>,
    properties: Vec<(String, Node)>,
    dependent: Vec<(String, Vec<String>)>,
}

impl Node {
    fn has_string_keywords(&self) -> bool {
        self.max_length.is_some() || self.min_length.is_some() || self.pattern.is_some()
    }

    fn has_object_keywords(&self) -> bool {
        !self.required.is_empty()
            || self.additional.is_some()
            || !self.properties.is_empty()
            || !self.dependent.is_empty()
    }
}

impl Schema {
    /// Reads a schema. A keyword the walker does not know, a `$ref` that is not to `#/$defs/…`, a type that is not
    /// one, or a pattern the matcher cannot read is refused, named.
    pub fn compile(schema: &Value) -> Result<Schema, String> {
        let root = compile(schema, schema, "#", 0)?;
        Ok(Schema { root })
    }

    /// What is wrong with `value`, one entry per fault, as src/ledger/schema.ts says it; `what` names the whole value
    /// (`an event`, `a line`). Empty when it holds.
    pub fn faults(&self, value: &Value, what: &str) -> Vec<String> {
        let mut found = Vec::new();
        check(&self.root, value, &[], what, &mut found);
        let mut seen = std::collections::HashSet::new();
        found.retain(|f| seen.insert(f.clone()));
        found
    }
}

fn compile(schema: &Value, root: &Value, path: &str, depth: usize) -> Result<Node, String> {
    if depth > 64 {
        return Err(format!("{path}: the schema refers to itself"));
    }
    let mut node = Node { path: path.to_string(), ..Node::default() };
    let members = match schema {
        Value::Bool(b) => {
            node.always = Some(*b);
            return Ok(node);
        }
        Value::Object(members) => members,
        _ => return Err(format!("{path}: a schema is an object or a boolean")),
    };
    for key in members.keys() {
        if !KNOWN.contains(&key.as_str()) {
            return Err(format!("{path}: the schema has a keyword the check does not know: {key}"));
        }
    }
    let sub = |name: &str, value: &Value| compile(value, root, &format!("{path}/{name}"), depth + 1);
    if let Some(defs) = members.get("$defs") {
        let defs = defs.as_object().ok_or(format!("{path}: $defs is not an object"))?;
        for (name, def) in defs {
            sub(&format!("$defs/{name}"), def)?;
        }
    }
    if let Some(reference) = members.get("$ref") {
        let target = reference.as_str().and_then(|r| r.strip_prefix("#/$defs/"));
        let found = target.and_then(|name| root.get("$defs")?.get(name));
        let Some(found) = found else {
            return Err(format!("{path}: the check knows only a $ref to #/$defs/…, not {reference}"));
        };
        let at = reference.as_str().unwrap_or_default();
        node.reference = Some(Box::new(compile(found, root, at, depth + 1)?));
    }
    if let Some(types) = members.get("type") {
        let names: Vec<&Value> = match types {
            Value::Array(list) => list.iter().collect(),
            one => vec![one],
        };
        for name in names {
            let text = name.as_str().unwrap_or_default();
            let Some(t) = Type::named(text) else {
                return Err(format!("{path}: the check knows no type {name}"));
            };
            node.types.push((text.to_string(), t));
        }
    }
    node.constant = members.get("const").cloned();
    if let Some(allowed) = members.get("enum") {
        node.allowed = Some(allowed.as_array().ok_or(format!("{path}: enum is not a list"))?.clone());
    }
    if let Some(not) = members.get("not") {
        node.not = Some(Box::new(sub("not", not)?));
    }
    if let Some(when) = members.get("if") {
        node.when = Some(Box::new(sub("if", when)?));
    }
    if let Some(then) = members.get("then") {
        node.then = Some(Box::new(sub("then", then)?));
    }
    let length = |name: &str| -> Result<Option<u64>, String> {
        members.get(name).map(|n| n.as_u64().ok_or(format!("{path}: {name} is not a count"))).transpose()
    };
    node.max_length = length("maxLength")?;
    node.min_length = length("minLength")?;
    if let Some(pattern) = members.get("pattern") {
        let source = pattern.as_str().ok_or(format!("{path}: pattern is not a string"))?;
        let compiled = Pattern::new(source).map_err(|e| format!("{path}: {e}"))?;
        node.pattern = Some((source.to_string(), compiled));
    }
    if let Some(required) = members.get("required") {
        node.required = names(required).ok_or(format!("{path}: required is not a list of names"))?;
    }
    if let Some(additional) = members.get("additionalProperties") {
        node.additional = Some(Box::new(sub("additionalProperties", additional)?));
    }
    if let Some(properties) = members.get("properties") {
        let properties = properties.as_object().ok_or(format!("{path}: properties is not an object"))?;
        for (name, property) in properties {
            node.properties.push((name.clone(), sub(&format!("properties/{name}"), property)?));
        }
    }
    if let Some(dependent) = members.get("dependentRequired") {
        let dependent = dependent.as_object().ok_or(format!("{path}: dependentRequired is not an object"))?;
        for (name, list) in dependent {
            let list = names(list).ok_or(format!("{path}: dependentRequired is not of lists of names"))?;
            node.dependent.push((name.clone(), list));
        }
    }
    Ok(node)
}

fn names(list: &Value) -> Option<Vec<String>> {
    list.as_array()?.iter().map(|n| n.as_str().map(String::from)).collect()
}

/// Checks `value` against `node`, adding each fault to `found` in ajv's order. `at` is the place of the value.
fn check(node: &Node, value: &Value, at: &[&str], what: &str, found: &mut Vec<String>) {
    // `where` as src/ledger/schema.ts makes it from ajv's instancePath: its parts, escaped, joined by dots. Made only
    // when a fault is said.
    let place = || at.iter().map(|p| p.replace('~', "~0").replace('/', "~1")).collect::<Vec<_>>().join(".");
    let named = || {
        let place = place();
        if place.is_empty() {
            what.to_string()
        } else {
            place
        }
    };
    let field = |name: &str| {
        let place = place();
        [place.as_str(), name].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(".")
    };
    match node.always {
        Some(true) => return,
        Some(false) => {
            found.push(format!("{}: boolean schema is false", named()));
            return;
        }
        None => {}
    }
    let type_holds = node.types.is_empty() || node.types.iter().any(|(_, t)| t.holds(value));
    let type_fault = || {
        let names: Vec<&str> = node.types.iter().map(|(n, _)| n.as_str()).collect();
        format!("{}: must be {}", named(), names.join(","))
    };
    // A node with keywords for its one type reports a wrong type in that type's turn; any other node reports it first.
    let one = match node.types.as_slice() {
        [(_, Type::String)] if node.has_string_keywords() => Some(Type::String),
        [(_, Type::Object)] if node.has_object_keywords() => Some(Type::Object),
        _ => None,
    };
    if one.is_none() && !type_holds {
        found.push(type_fault());
    }

    // The keywords of any type.
    if let Some(target) = &node.reference {
        check(target, value, at, what, found);
    }
    if let Some(constant) = &node.constant {
        if !js_equal(constant, value) {
            found.push(format!("{}: must be equal to constant", named()));
        }
    }
    if let Some(allowed) = &node.allowed {
        if !allowed.iter().any(|a| js_equal(a, value)) {
            let list: Vec<String> = allowed.iter().map(join_text).collect();
            found.push(format!("{}: must be one of {}", place(), list.join(", ")));
        }
    }
    if let Some(not) = &node.not {
        if holds(not, value) {
            // The only `not` of the schema: `to` on a type that is not a task given or taken back.
            if node.path == "#" {
                found.push("to: only on task.assigned and task.unassigned".to_string());
            } else {
                found.push(format!("{}: must NOT be valid", named()));
            }
        }
    }
    if let (Some(when), Some(then)) = (&node.when, &node.then) {
        // `if` only says that a branch failed; the branch says what.
        if holds(when, value) {
            check(then, value, at, what, found);
        }
    }

    // The keywords of strings.
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if let Some(max) = node.max_length {
            if length > max {
                found.push(format!("{}: must NOT have more than {max} characters", named()));
            }
        }
        if let Some(min) = node.min_length {
            if length < min {
                found.push(format!("{}: must NOT have fewer than {min} characters", named()));
            }
        }
        if let Some((source, pattern)) = &node.pattern {
            if !pattern.is_match(text) {
                found.push(format!("{}: must match pattern \"{source}\"", named()));
            }
        }
    } else if one == Some(Type::String) {
        found.push(type_fault());
    }

    // The keywords of objects.
    if let Some(members) = value.as_object() {
        for name in &node.required {
            if !members.contains_key(name) {
                found.push(format!("{}: missing", field(name)));
            }
        }
        if let Some(additional) = &node.additional {
            for key in js_keys(members) {
                if node.properties.iter().any(|(name, _)| name == key) {
                    continue;
                }
                if additional.always == Some(false) {
                    found.push(format!("{}: not a field of {what}", field(key)));
                } else {
                    let mut inner = at.to_vec();
                    inner.push(key);
                    check(additional, &members[key.as_str()], &inner, what, found);
                }
            }
        }
        for (name, property) in &node.properties {
            if property.always == Some(true) {
                continue;
            }
            if let Some(member) = members.get(name) {
                let mut inner = at.to_vec();
                inner.push(name);
                check(property, member, &inner, what, found);
            }
        }
        for (name, needs) in &node.dependent {
            if !members.contains_key(name) {
                continue;
            }
            let word = if needs.len() == 1 { "property" } else { "properties" };
            for need in needs {
                if !members.contains_key(need) {
                    let list = needs.join(", ");
                    found.push(format!("{}: must have {word} {list} when property {name} is present", named()));
                }
            }
        }
    } else if one == Some(Type::Object) {
        found.push(type_fault());
    }
}

/// Whether `value` holds against `node`, with no faults kept.
fn holds(node: &Node, value: &Value) -> bool {
    let mut found = Vec::new();
    check(node, value, &[], "", &mut found);
    found.is_empty()
}

/// The keys of an object in JavaScript's order: those that are array indices first, in numeric order, then the rest
/// in the order they came.
fn js_keys(members: &Map<String, Value>) -> Vec<&String> {
    let index = |key: &str| -> Option<u32> {
        let canonical = key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
        let n: u32 = if canonical && !key.is_empty() { key.parse().ok()? } else { return None };
        (n < u32::MAX).then_some(n)
    };
    let mut indices: Vec<(u32, &String)> = members.keys().filter_map(|k| Some((index(k)?, k))).collect();
    indices.sort_by_key(|&(n, _)| n);
    let rest = members.keys().filter(|k| index(k).is_none());
    indices.into_iter().map(|(_, k)| k).chain(rest).collect()
}

/// Equality as ajv's deep equal has it: numbers by value, objects whatever the order of their keys.
fn js_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| js_equal(x, y)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| js_equal(v, w)))
        }
        _ => a == b,
    }
}

/// A value as Array.prototype.join writes it: a string as it is, null as nothing.
fn join_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => crate::keys::js_string(Some(other)),
    }
}

fn event_schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| embedded(EVENT_SCHEMA))
}

fn line_schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| embedded(LINE_SCHEMA))
}

fn embedded(text: &str) -> Schema {
    let value: Value = serde_json::from_str(text).expect("the embedded schema is JSON");
    Schema::compile(&value).expect("the embedded schema has only keywords the check knows: its test says so")
}

/// What is wrong with a value as an event, one entry per fault. Empty when it is valid.
pub fn event_faults(value: &Value) -> Vec<String> {
    let mut found = event_schema().faults(value, "an event");
    // The pattern of `time` lets in a day that is not on the calendar and an hour that is not on the clock.
    if let Some(time) = value.get("time").and_then(Value::as_str) {
        if value.is_object() && !is_real_time(time) {
            found.push("time: not a real time".to_string());
        }
    }
    found
}

/// What is wrong with a value as a line of the ledger, leaving its event aside. Empty when it is valid.
pub fn line_faults(value: &Value) -> Vec<String> {
    line_schema().faults(value, "a line")
}
