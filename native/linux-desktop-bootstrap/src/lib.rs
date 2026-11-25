//! The independently distributed Linux desktop first-install bootstrap.
//!
//! It authenticates signed release inputs with an embedded trust pin, stages
//! the payload into an owner-local generation, and publishes the stable
//! launcher once. It does not launch, update or open product state.

pub mod archive;
pub mod asar;
pub mod error;
pub mod install;
pub mod release;
pub mod trust;
pub mod verify;
