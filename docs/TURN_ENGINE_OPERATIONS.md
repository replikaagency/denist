# Lectura operativa: `turn_engine.branch`

**Política de canales (oficial vs legacy vs fase interna):** [TELEMETRY_CHANNELS.md](./TELEMETRY_CHANNELS.md).

**Convención (una línea):** toda conclusión de negocio sale de `turn_engine.branch`; todo lo demás es contexto.

## Contratos de nombres (no mezclar)

Hay **tres sistemas de nombres en paralelo** en el motor de conversación. No son intercambiables:

| Sistema | Qué es | Dónde mirar |
|--------|--------|-------------|
| **`TurnEngineBranch`** | Contrato **estable de observabilidad** para el evento `turn_engine.branch` (logs JSON y, si aplica, filas en `turn_engine_branch_events`). | `src/lib/conversation/turn-engine-branches.ts` |
| **`turnPhaseComplete(..., { branchTaken })`** | Metadato **interno heredado** del pipeline por fases; identifica cómo terminó una fase, **no** garantiza el mismo vocabulario que `TurnEngineBranch`. | `src/lib/conversation/turn-phases/types.ts` y fases |
| **`conversation_flow`** | Canal de logging **histórico en paralelo** (`logConversationFlow`); `branch_taken` ahí sigue la convención antigua **`conversation_flow`**, no la de `turn_engine.branch`. | `src/lib/logger/flow-logger.ts` |

**Regla:** al instrumentar dashboards, queries o documentación nueva, usar solo los ids definidos en `turn-engine-branches.ts` para `turn_engine.branch`. No asumir que un `branchTaken` de fase o un `branch_taken` de `conversation_flow` coinciden con ese catálogo.

## Dónde está cada cosa

| Canal | Contenido |
|-------|-----------|
| **JSON stdout** (`log`) | Evento `turn_engine.branch` con `input_summary` **enmascarado** (`sanitizeInputSummaryForLog`). |
| **Supabase** `turn_engine_branch_events` | Solo ids: `branch_taken`, `current_step`, `allow_llm`, `conversation_id`, `created_at`. **Sin texto del paciente.** |

La tabla se rellena en servidor cuando existen `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. Sin env, solo hay logs stdout.

## Vistas (últimos 7 días)

Tras aplicar la migración `0012_turn_engine_branch_events.sql`, en el SQL Editor de Supabase:

1. **`turn_engine_top_branch_volume`** — volumen por `branch_taken`.
2. **`turn_engine_top_coordinator_yields`** — ramas `coordinator.yield%`.
3. **`turn_engine_top_llm_fallbacks`** — `llm.call_failed` y `llm.parse_recover*`.
4. **`turn_engine_top_branches_before_handoff`** — última rama `turn_engine` antes de cada fila en `handoff_events` (misma conversación, timestamp ≤ handoff).

Para otra ventana temporal, duplica la vista en SQL y cambia `interval '7 days'`.

## Privacidad

- No guardar `input_summary` en base de datos; el detalle sigue en logs de aplicación ya sanitizados.
- Revisar periodicamente que los dashboards solo consulten las vistas/tablas anteriores, no logs crudos con PII.
