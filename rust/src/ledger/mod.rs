// The ledger: JSON read as JSON.parse reads it, the fixed form of an event, the hash of a line, the schema check,
// the place of a ledger and its check.
// @code_class evidence
pub mod fixed;
pub mod json;
pub mod line;
pub mod log;
pub mod pattern;
pub mod place;
pub mod schema;
pub mod time;
pub mod verify;
