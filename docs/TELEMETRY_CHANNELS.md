# Política de canales de telemetría (Dental Reception AI)

Documento interno: define **qué canal usar para qué** sin unificar vocabularios en runtime. No sustituye la guía operativa de `turn_engine.branch`; véase también [TURN_ENGINE_OPERATIONS.md](./TURN_ENGINE_OPERATIONS.md).

## Convención operativa (una línea)

> **Toda conclusión de negocio sale de `turn_engine.branch`; todo lo demás es contexto.**

`conversation_flow`, logs ad hoc, metadatos de fase (`TurnPhaseResult.branchTaken`) u otros canales pueden **explicar** o **cruzar** datos, pero no sustituyen al contrato oficial para afirmar KPIs, causas raíz de producto o decisiones que dependan de “qué rama del motor contó el sistema”.

---

## Canales

### 1. `turn_engine.branch`

| | |
|--|--|
| **Canal** | Evento estructurado `turn_engine.branch` (JSON / opcionalmente tabla `turn_engine_branch_events`). |
| **Propósito** | Contrato **oficial** de observabilidad del motor de turno: ramas tipadas y estables. |
| **Uso permitido** | Métricas, dashboards, alertas, análisis de producto/ops, vistas SQL basadas en ids del catálogo. |
| **Uso prohibido** | Tratarlo como sustituto de otros canales sin documentación; asumir equivalencia 1:1 con campos legacy sin mapeo explícito. |
| **Notas** | Los ids viven en `turn-engine-branches.ts`. Es la única fuente que debe etiquetarse como **oficial** en informes nuevos. |

### 2. `conversation_flow`

| | |
|--|--|
| **Canal** | Logging histórico (`logConversationFlow`, p. ej. `branch_taken` dentro de ese flujo). |
| **Propósito** | Trazabilidad **legacy** con semántica mezclada a lo largo del tiempo. |
| **Uso permitido** | Lectura histórica, comparaciones longitudinales **consciente** de que el significado puede haber cambiado; migraciones aditivas futuras. |
| **Uso prohibido** | Comparar directamente con `turn_engine.branch` como si fueran el mismo concepto; usarlo como fuente principal de dashboards nuevos sin etiquetar origen. |
| **Notas** | **No es equivalente** a `turn_engine.branch`. Cualquier cruce entre canales requiere **mapeo o etiqueta de origen** documentada. |

### 3. `turnPhaseComplete` / `TurnPhaseResult.branchTaken`

| | |
|--|--|
| **Canal** | Campo opcional en el resultado de fase (`TurnPhaseResult.branchTaken`), rellenado vía `turnPhaseComplete(..., { branchTaken })`. |
| **Propósito** | Metadato **interno** de fase (heredado); no forma parte del contrato HTTP ni de `ChatTurnResult`. |
| **Uso permitido** | Depuración local, trazas en desarrollo, o tests que inspeccionen el objeto de fase **si** el equipo lo mantiene a propósito. |
| **Uso prohibido** | Métricas, dashboards, alertas, series temporales de producto, o cualquier informe que deba alinearse con el catálogo oficial. |
| **Notas** | No se propaga al cliente; `takeCompletedTurnResult` solo devuelve `outcome`. **No es contrato de telemetría oficial.** |

---

## Reglas de política

1. **Dashboards y alertas oficiales** deben basarse en **`turn_engine.branch`** (ids del catálogo), no en `conversation_flow` ni en `TurnPhaseResult.branchTaken`.
2. **`conversation_flow`** se considera **legacy / histórico** hasta que exista una migración **aditiva** que aclare semántica sin romper históricos (p. ej. campos nuevos en paralelo).
3. **`turnPhaseComplete.branchTaken` / `TurnPhaseResult.branchTaken`** **no** debe usarse para métricas ni paneles de producción.
4. Si un análisis combina más de un canal, es **obligatorio** etiquetar cada serie o columna con **`telemetry_channel`** o **`source`** (p. ej. `turn_engine.branch` vs `conversation_flow` vs `phase_internal`) para no mezclar interpretaciones en el mismo gráfico sin contexto.

### Comprobación automática (tests)

`npm test` incluye un escaneo estático ligero (`src/tests/telemetry-channel-guard.test.ts` + `telemetry-channel-guard.scan.ts`) sobre `src/**/*.ts` y `src/**/*.tsx` que **no cambia runtime**: lista permitida en `src/tests/telemetry-channel-guard.allowlist.json` para uso legacy de `logConversationFlow`, comprobación de que `turnPhaseComplete(` solo aparece bajo `**/turn-phases/**` (tras eliminar comentarios), y que el `log('info', 'conversation_flow', …)` solo existe en `flow-logger.ts`. Rutas con segmento `metrics`, `analytics`, `dashboard` o `monitoring` no pueden contener `logConversationFlow`. Ampliar la allowlist solo tras revisión explícita.

---

## Decisión pendiente: `TurnPhaseResult.branchTaken`

El equipo debe elegir explícitamente una línea (sin bloquear el resto de la política anterior):

| Opción | Descripción |
|--------|-------------|
| **A — Deprecar y eliminar más adelante** | Tratar el campo como legado técnico; documentar deprecación; planificar eliminación tras comprobar que no hay dependencias ocultas (tests, tooling). |
| **B — Mantener solo para debug / tests locales** | Conservar el campo únicamente como ayuda de depuración o aserciones en tests que lean `TurnPhaseResult`; seguir prohibido para telemetría de producto. |

Hasta decidir, aplicar la regla: **no usar para métricas** (tabla de arriba).
