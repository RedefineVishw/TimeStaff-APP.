import { useEffect, useState } from "react";
import { IdleAlertDialog } from "./IdleAlertDialog";

// The content of the separate always-on-top idle-alert window (see
// main.ts's createIdleAlertWindow). Deliberately "dumb" — it only displays
// whatever data the main window's renderer sent it and reports the user's
// choice back; all the real timer/API logic stays in App.tsx.
export function IdleAlertWindowApp() {
  const [data, setData] = useState<{ idleSeconds: number; projectName: string; taskName: string } | null>(null);
  const [wasWorking, setWasWorking] = useState<"no" | "yes">("no");

  useEffect(() => {
    return window.timeStaff.idleAlert.onData((incoming) => {
      setData(incoming);
      setWasWorking("no");
    });
  }, []);

  if (!data) return null;

  return (
    <div className="idle-alert-window">
      <IdleAlertDialog
        idleSeconds={data.idleSeconds}
        projectName={data.projectName}
        taskName={data.taskName}
        wasWorking={wasWorking}
        onWasWorkingChange={setWasWorking}
        onStop={() => window.timeStaff.idleAlert.respond({ action: "stop", wasWorking })}
        onResume={() => window.timeStaff.idleAlert.respond({ action: "resume", wasWorking })}
        busy={false}
      />
    </div>
  );
}
