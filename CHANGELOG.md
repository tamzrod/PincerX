# Changelog

## [2.1.0] - 2025-01-15

### Added

- **Story Coherence Engine** (`story/story-coherence.js`): A lightweight layer for validating narrative consistency
  - Character consistency checking against established personalities
  - World rule/lore adherence validation
  - Narrative continuity checks against previous chapters
  - "What if" analysis for exploring alternative story directions
  - Character profile validation for internal consistency

- **Coherence API endpoints**:
  - `GET /story/:id/coherence/health` - Story health summary
  - `POST /story/:id/coherence/check` - Chapter coherence validation
  - `POST /story/:id/coherence/validate-character` - Character profile validation
  - `POST /story/:id/coherence/whatif` - "What if" scenario exploration

- **Coherence tests** (`tests/story-coherence.test.js`): 16 tests for coherence functions

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
