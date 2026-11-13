import FilaPanel from "./FilaPanel";
import { useSim } from "@/lib/simContext";
import { activeBrokers, scheduleAt } from "@/lib/queue/shiftSchedule";
import type { Broker, QueueEntry } from "@/lib/supabase";
export default function ScheduledFilaPanel(props: {
  brokers: Broker[];
  queue: QueueEntry[];
  allQueue: QueueEntry[];
}) {
  const { simSeconds, isExtendedShift, plantaoDate } = useSim();
  const clock = {
    seconds: simSeconds,
    singleShift: isExtendedShift,
    date: plantaoDate,
  };
  const project = (rows: QueueEntry[]) =>
    rows.map((entry) => {
      const visit = entry.visit as QueueEntry["visit"] & {
        pre_opening_assignee?: string;
      };
      if (scheduleAt(clock).preOpening && visit?.pre_opening_assignee)
        return {
          ...entry,
          visit: { ...visit, referred_broker_id: visit.pre_opening_assignee },
        };
      return entry;
    });
  const activeIds = new Set(
    activeBrokers(props.brokers, clock).map((b) => b.id),
  );
  const brokers = props.brokers.map((b) =>
    activeIds.has(b.id) ? b : { ...b, presence_status: "ausente" as const },
  );
  return (
    <FilaPanel
      brokers={brokers}
      queue={project(props.queue)}
      allQueue={project(props.allQueue)}
    />
  );
}
