// The inbox: where hooks and scripts leave events for the one writer.
// @code_class recording
// Named as src/inbox/: deliver.ts, down.ts and inbox.ts.
pub mod deliver;
pub mod down;
#[allow(clippy::module_inception)]
pub mod inbox;
