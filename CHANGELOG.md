# Changelog

## [2.0.0] - 2025-01-15

### Changed

- **Project identity**: PincerX is now explicitly a local creative storytelling system. All project documentation and branding have been updated accordingly.

- **Module reorganization**: The `openclaw/` directory has been renamed to `lib/`. All internal imports have been updated:
  - `openclaw/ai.js` → `lib/ai.js`
  - `openclaw/rag.js` → `lib/rag.js`
  - `openclaw/feedback.js` → `lib/feedback.js`

- **Package metadata**: Updated `package.json` description to reflect the storytelling focus.

- **Architecture documentation**: Completely rewritten `docs/architecture.md` to document the new structure and focus.

### Removed

- All references to "OpenClaw" branding throughout the codebase, documentation, and comments.

### Notes

The core functionality is unchanged. This release is primarily a rebranding and reorganization to clarify PincerX's purpose as a storytelling tool rather than a generic RAG system.
