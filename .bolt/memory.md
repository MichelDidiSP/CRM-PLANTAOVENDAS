# Project memory

## Product intent & audience

- Queue and registration engine for reception staff managing broker check-ins, afternoon draws, client referrals, and broker rotation.
- Primary operational context is weekday afternoon registration and referral distribution across broker teams/companies.
- Interface includes Portuguese operational terminology, including “Indicação,” “Inscrição do Turno da Tarde,” and afternoon-shift status.

## Brand personality & voice

- Operational, clear, and immediately actionable for reception users.
- Status and warnings should make timing, eligibility, and blocked actions unambiguous.
- Use concise Portuguese labels consistent with existing reception terminology.

## Visual design & UX direction

- Reception view should surface the afternoon registration panel from 13:00 on weekdays, rather than hiding it until a broker checks in.
- The panel lists afternoon-shift brokers and visibly distinguishes late arrivals.
- The 13:46 draw needs a visible warning/alert when no afternoon brokers are registered; keep registration controls accessible instead of allowing an empty draw.
- Prefer existing project components, Tailwind styling, React hooks, and Lucide icons; avoid introducing UI dependencies.
- Preserve responsive reception usability and clear status feedback around check-in eligibility and referral routing.

## Decisions, constraints & rationale

- Late status is represented by the existing `isLateForSort` behavior for check-ins after the afternoon draw; referral-transfer helpers must honor it.
- Referral fallback cascades backward through the same team/company queue (last broker, then earlier brokers), but skips late brokers from receiving transferred referrals.
- A late broker may still receive:
  - Their own explicit/direct referrals.
  - A client when their normal direct-queue turn arrives.
  - A transferred referral only when they are the sole checked-in broker for that company.
- The late-broker exclusion applies until the original queue completes one full rotation, per the requested business rule.
- Afternoon registration is explicitly opened at 13:00 on weekdays.
- The 13:46 afternoon draw must be blocked or warned when zero afternoon brokers are checked in; it should not execute against an empty list. It may proceed after a broker checks in.
- Current implementation reportedly builds successfully.
- Existing engine tests currently show 4 failures out of 37. They were not resolved or conclusively compared against a pre-change baseline. One reported failure is caused by fixtures sharing the same team name, causing same-team routing to win before the intended cross-agency step; other rotation failures may involve shared test state.
- Do not treat the existing test failures as fixed or fully unrelated without reproducing against the prior implementation.

## Open questions & assumptions

- Verify the exact “one full rotation” state transition: current changes reportedly skip late brokers in referral helpers, but it is unclear whether rotation completion is explicitly tracked or only implied by queue position.
- Confirm whether “after the 13:46 afternoon draw” means strictly `> 13:46` or includes arrivals exactly at 13:46.
- Confirm timezone and clock-source behavior for weekday/13:00/13:46 checks, especially around seconds and test environments.
- Determine whether the empty-draw warning should be a persistent reception banner, modal/alert, toast, or a disabled draw action.
- Add or update focused tests for: late broker skipped in same-team and same-company fallback, sole-company late-broker override, direct referral eligibility, normal-turn eligibility, 13:00 panel visibility, weekday/weekend boundaries, and empty 13:46 draw prevention.
- Inspect the four failing existing tests before relying on the current suite as a regression signal.