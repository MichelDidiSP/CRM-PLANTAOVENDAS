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

- Reception view surfaces the afternoon registration panel from 13:00 on weekdays and visibly distinguishes late arrivals.
- Client-creation views separate brokers into:
  - “Presente”: only brokers whose active status is exactly `presente`.
  - “Ausente”: brokers with `ausente` or `pausa`.
- Paused brokers retain a visible “Pausa” label rather than being mislabeled as absent.
- The 13:46 draw shows a clear warning or blocked state when no afternoon brokers are registered, while keeping registration controls accessible.
- Preserve responsive reception usability and clear feedback around check-in eligibility, referral routing, return-from-absence behavior, and own-referral-only restrictions.
- Prefer existing project components, Tailwind styling, React hooks, and Lucide icons; avoid introducing UI dependencies.
- A broker-card badge for the own-referrals-only state has not yet been added.

## Decisions, constraints & rationale

- Active broker statuses are `presente`, `ausente`, and `pausa`.
- Present-list filtering is strict: only `presente` qualifies. Paused brokers remain unavailable for standard assignment.
- Routing helpers require `presente`; paused and absent brokers are excluded from round-robin, normal transfers, and company/team referral chains.
- Brokers entering `pausa` or `ausente` receive a departure timestamp. Manual status changes and automatic pause writers use the simulated/application clock consistently.
- Returning from either `pausa` or `ausente` applies the same re-entry logic:
  - If the original turn is due or already passed, the broker loses immediate top priority and is placed immediately after the currently served broker (`current_turn + 1`).
  - If returning before their turn and before the same-company broker ahead of them is served, they retain their original queue position.
- Absence penalty is strict: duration must exceed 120 minutes; exactly 120 minutes does not trigger it.
- After the penalty, the broker permanently receives an own-referrals-only flag for that shift (implemented as a broker field), loses direct and reverse queue positions, and is excluded from round-robin and all company/team transfer chains.
- Own-referrals-only brokers may receive only their own direct personal referrals.
- Penalty enforcement runs on application clock ticks, including when the broker does not return. Departure timestamp is cleared on return; the penalty flag resets at restart and afternoon transition.
- Existing late-broker rules remain: late brokers are excluded from transferred referrals until the applicable queue rotation condition, with documented exceptions for direct referrals, normal direct turns, and sole checked-in-company cases.
- Afternoon registration opens at 13:00 on weekdays; the 13:46 draw must not execute against an empty broker list.
- Database schema now includes departure-time and per-shift own-referrals-only fields for brokers. The migration is idempotent and requires no new policies or grants.
- Build passes and nine new focused tests pass. Four older engine tests remain failing and were not conclusively established as regressions.

## Open questions & assumptions

- Verify every reception/simulation client-creation view uses strict `presente` filtering and groups both `ausente` and `pausa` as unavailable.
- Confirm whether management-screen “Presente” totals should exclude paused brokers; that screen currently still counts `pausa` as present.
- Confirm the exact implementation and test coverage for preserving an early returnee’s original position relative to the same-company broker ahead.
- Verify the “current turn + 1” insertion behavior when the active turn is at a queue boundary or when no broker is currently being served.
- Confirm whether “permanent for that shift” should survive browser reloads but reset only at restart/afternoon transition, matching the current implementation.
- Determine the desired UI treatment for own-referrals-only brokers, including badge, explanatory text, and disabled transfer actions.
- Confirm timezone and clock-source behavior around weekday, 13:00, 13:46, and the strict 120-minute boundary.
- Inspect and resolve the four pre-existing engine test failures before treating the full suite as a regression signal.
- Continue focused coverage for paused/absent filtering, re-entry positioning, exact and over-120-minute penalties, own-referral routing, late-broker fallback, draw prevention, and shift resets.