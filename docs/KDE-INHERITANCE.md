# KDE Engine Inheritance

This document maps the Story Coherence Engine to its KDE engine origins.

## Source

- **Repository**: https://github.com/tamzrod/kde
- **Adapted from**: KDE-ENGINE-002 (Beta) and KDE-ENGINE-003 (Gamma)

## Mapping Table

| KDE Concept | Engine | PincerX Implementation | File |
|-------------|--------|------------------------|------|
| **Context Detection** | Beta | `checkLoreConsistency()`, `checkCharacterConsistency()` | `story/story-coherence.js` |
| **Boundary Detection** | Beta | `checkLoreConsistency()` with `boundaries` array, `checkCharacterConsistency()` with `boundaries` array | `story/story-coherence.js` |
| **Confidence & Evidence** | Beta | `confidence` field (0-1), `evidence` field in `CoherenceResult` | `story/story-coherence.js` |
| **Causal Mechanism** | Gamma | `checkCausalLogic()` with `mechanism` field | `story/story-coherence.js` |
| **Intervention Thinking** | Gamma | `whatIf()` with intervention analysis | `story/story-coherence.js` |

## KDE-ENGINE-002 (Beta) Adaptation

Beta provides the reasoning pattern for validating knowledge under specific conditions.

### Core Questions (from Beta)

1. **Context Detection**: "Under what conditions is this story element valid?"
2. **Boundary Detection**: "When does this rule/trait stop being true?"
3. **Confidence**: "How certain is this coherence check?"

### PincerX Implementation

```javascript
// Example: Beta-style boundary detection in checkLoreConsistency
const prompt = [
  'KDE-BETA CORE QUESTIONS (Boundary Detection):',
  '- Under what conditions is each world rule valid?',
  '- When does each rule stop being true? (explicit boundary)',
  '- What would cause this rule to break or change?',
  // ...
];

// Result includes boundaries array
return {
  isConsistent: true,
  confidence: 0.85,
  boundaries: [
    "Magic: Only works during daylight hours",
    "The Kingdom: Falls when the king dies without heir"
  ]
};
```

## KDE-ENGINE-003 (Gamma) Adaptation

Gamma provides the reasoning pattern for causal chains and intervention analysis.

### Core Questions (from Gamma)

1. **Causal Mechanism**: "How does X cause Y? What consequence does this set up?"
2. **Intervention**: "What happens if we change X? How does that affect Y?"

### PincerX Implementation

```javascript
// Example: Gamma-style causal mechanism in checkCausalLogic
const prompt = [
  'KDE-GAMMA CORE QUESTIONS (Causal Mechanism):',
  '- How does event X cause event Y? (trace the causal chain)',
  '- What is the character motivation driving each action?',
  '- What consequence does each cause set up?',
  '- Are there causal gaps (effects without mechanisms)?',
  // ...
];

// Result includes mechanism explanation
return {
  isConsistent: true,
  mechanism: "Elena's discovery of the map (cause) -> her decision to investigate (action) -> the confrontation with the shadow guard (consequence)"
};
```

## Response Format

All coherence checks return a `CoherenceResult` object:

```typescript
interface CoherenceResult {
  isConsistent: boolean;      // Whether the element is consistent
  confidence: number;         // 0-1 confidence score (KDE-Beta)
  level: 'high' | 'medium' | 'low';
  warnings: string[];         // List of potential issues
  suggestions: string[];       // How to address issues
  evidence: string;           // Explanation of the check (KDE-Beta)
  boundaries?: string[];       // Explicit boundary conditions (KDE-Beta)
  mechanism?: string;          // Causal mechanism explanation (KDE-Gamma)
}
```

## Key Design Decisions

1. **Lightweight**: No full KDE laboratory system imported — only the reasoning patterns
2. **Story-focused**: Adapted the abstract KDE concepts to creative writing context
3. **Grounded**: Always validates against established story rules before suggesting changes
4. **Actionable**: Returns warnings and suggestions that writers can use directly

## Usage

```bash
# Check chapter coherence with full KDE-style analysis
curl -X POST http://localhost:3000/story/{id}/coherence/check \
  -H "Content-Type: application/json" \
  -d '{"chapterContent": "[speaker:Elena]..."}'

# Response includes boundaries and mechanism
{
  "isConsistent": true,
  "confidence": 0.85,
  "level": "high",
  "warnings": [],
  "suggestions": ["No issues detected"],
  "evidence": "All character actions align with established personalities",
  "boundaries": [
    "Elena: Acts bravely only when others are in danger",
    "The Forest: Magic最强的 only at the clearing"
  ],
  "mechanism": "Elena's curiosity (motivation) -> she opens the chest (action) -> she discovers the ancient map (consequence)"
}
```
