# Project memory

## Product intent & audience

- Queue and registration engine for reception staff managing broker check-ins, afternoon draws, client referrals, and broker rotation.
- Primary operational context is weekday afternoon registration and referral distribution across broker teams/companies.
- Reception and simulation views use Portuguese operational terminology such as “Indicação,” “Inscrição do Turno da Tarde,” “Presente,” “Ausente,” and “Pausa.”

## Brand personality & voice

- Operational, clear, and immediately actionable for reception users.
- Status, timing, eligibility, and blocked actions should be unambiguous.
- Use concise Portuguese labels consistent with established reception terminology.
- Distinguish “Pausa” from “Ausente” in broker-facing lists while grouping both under unavailable behavior where appropriate.

## Visual design & UX direction

- Reception view should surface the afternoon registration panel from 13:00 on weekdays, rather than hiding it until a broker checks in.
- The panel lists afternoon-shift brokers and visibly distinguishes late arrivals.
- Client-creation views separate brokers into:
  - “Presente”: only brokers whose active status is exactly `presente`.
  - “Ausente”: brokers with `ausente` or `pausa`.
- When shown in the unavailable list, paused brokers should retain a visible “Pausa” label rather than being mislabeled as absent.
- The 13:46 draw needs a visible warning/alert when no afternoon brokers are registered; keep registration controls accessible instead of allowing an empty draw.
- Prefer existing project components, Tailwind styling, React hooks, and Lucide icons; avoid introducing UI dependencies.
- Preserve responsive reception usability and clear status feedback around check-in eligibility and referral routing.

## Decisions, constraints & rationale

- Active broker status values include `presente`, `ausente`, and `pausa`.
- Present-list filtering is strict: only `presente` qualifies. Do not use a broad “not absent” check.
- Paused brokers are treated as unavailable for standard client assignment, matching absent-broker restrictions.
- Routing helpers currently require `presente`, which excludes paused brokers from normal round-robin clients and referral transfers. Preserve this invariant in future routing changes.
- A paused broker may not receive standard round-robin or transferred referrals unless a separately documented business rule explicitly changes unavailable-status behavior.
- Late status is represented by the existing `isLateForSort` behavior for check-ins after the afternoon draw; referral-transfer helpers must honor it.
- Referral fallback cascades backward through the same team/company queue, but skips late brokers from receiving transferred referrals.
- A late broker may still receive their own explicit/direct referrals, a client when their normal direct-queue turn arrives, and a transferred referral when they are the sole checked-in broker for that company.
- The late-broker exclusion applies until the original queue completes one full rotation; whether this is explicitly tracked remains unresolved.
- Afternoon registration is explicitly opened at 13:00 on weekdays.
- The 13:46 afternoon draw must be blocked or warned when zero afternoon brokers are checked in; it should not execute against an empty list.
- Current implementation reportedly builds successfully after the broker status visibility update.
- Existing engine tests previously showed 4 failures out of 37; they were not conclusively compared with a pre-change baseline. Shared team-name fixtures and shared test state were suspected contributors.

## Open questions & assumptions

- Verify whether every reception/simulation client-creation view uses the strict `presente` filter and groups both `ausente` and `pausa` in the unavailable list.
- Confirm whether paused brokers should count toward any check-in-panel “present” totals. The current count reportedly uses “not absent,” so it may include paused brokers even though they are unavailable for dispatch.
- Verify the exact “one full rotation” state transition for late-broker referral eligibility.
- Confirm whether “after the 13:46 afternoon draw” means strictly `> 13:46` or includes arrivals exactly at 13:46.
- Confirm timezone and clock-source behavior for weekday/13:00/13:46 checks, especially around seconds and test environments.
- Determine whether the empty-draw warning should be a persistent reception banner, modal/alert, toast, or disabled draw action.
- Add or update focused tests for paused/absent filtering, paused exclusion from round-robin and referral transfers, late-broker fallback rules, direct referral eligibility, normal-turn eligibility, 13:00 panel visibility, weekday/weekend boundaries, and empty 13:46 draw prevention.
- Inspect the four existing failing tests before relying on the current suite as a regression signal.