"use client";

import type { ScanResult } from "@gym/core/attendance";
import { Alert, Badge, Button, Card, CardTitle } from "@gym/ui";
import { Camera, CameraOff, CheckCircle2, XCircle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  manualCheckInAction,
  scanAction,
  searchMembersAction,
} from "./actions";

type Branch = { id: string; name: string; checkoutEnabled: boolean };
type Device = { id: string; name: string; branchId: string };
type Found = {
  id: string;
  name: string;
  memberCode: string;
  branch: string;
  phoneLast4: string | null;
};

// The native detector (Chrome/Edge on Android, desktop) — not in TypeScript's DOM types yet.
type Detector = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => Detector;
  }
}

const DEVICE_KEY = "gym:scan-device";

function readSavedDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return ""; // storage blocked: scans still work without a device name
  }
}
const noSubscribe = () => () => {};

function Initials({ name }: { name: string }) {
  const letters = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      aria-hidden="true"
      className="flex size-20 shrink-0 items-center justify-center rounded-full bg-primary/10 text-2xl font-semibold text-primary"
    >
      {letters}
    </div>
  );
}

function ResultPanel({ result }: { result: ScanResult }) {
  const ok = result.result === "ACCEPTED";
  return (
    <div
      className={`flex flex-col gap-4 rounded-lg border-2 p-5 ${
        ok ? "border-success bg-success-soft" : "border-danger bg-danger-soft"
      }`}
      data-testid="scan-result"
      data-result={result.result}
    >
      <div className="flex items-center gap-3">
        {ok ? (
          <CheckCircle2 aria-hidden="true" className="size-10 text-success" />
        ) : (
          <XCircle aria-hidden="true" className="size-10 text-danger" />
        )}
        <p
          className={`text-2xl font-bold ${ok ? "text-success" : "text-danger"}`}
        >
          {ok
            ? result.type === "CHECK_OUT"
              ? "Checked out"
              : "Checked in"
            : "Not allowed"}
        </p>
      </div>
      {result.member && (
        <div className="flex items-center gap-4">
          {result.member.hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/members/${result.member.id}/photo`}
              alt={`Photo of ${result.member.name}`}
              className="size-20 shrink-0 rounded-full object-cover"
            />
          ) : (
            <Initials name={result.member.name} />
          )}
          <div className="min-w-0">
            <p className="truncate text-xl font-semibold">
              {result.member.name}
            </p>
            <p className="text-sm text-muted">{result.member.memberCode}</p>
            {result.membership && (
              <p className="text-sm">
                {result.membership.planName} · until {result.membership.endDate}
              </p>
            )}
          </div>
        </div>
      )}
      {(!ok || !result.member) && (
        <p className="text-base font-medium">{result.message}</p>
      )}
      {result.warnings.map((w) => (
        <Badge key={w} tone="warning" className="self-start text-sm">
          {w}
        </Badge>
      ))}
      {result.markedClasses > 0 && (
        <p className="text-sm">
          Marked {result.markedClasses} booked class
          {result.markedClasses === 1 ? "" : "es"} as attended.
        </p>
      )}
    </div>
  );
}

export function ScanStation({
  branches,
  defaultBranchId,
  devices,
  canOverride,
}: {
  branches: Branch[];
  defaultBranchId: string;
  devices: Device[];
  canOverride: boolean;
}) {
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [chosenDevice, setChosenDevice] = useState<string | null>(null);
  const savedDevice = useSyncExternalStore(
    noSubscribe,
    readSavedDevice,
    () => "",
  );
  const [chosenMode, setMode] = useState<"CHECK_IN" | "CHECK_OUT">("CHECK_IN");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState<"off" | "starting" | "on">("off");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [wedge, setWedge] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastRef = useRef<{ value: string; at: number } | null>(null);
  const busyRef = useRef(false);

  const branch = branches.find((b) => b.id === branchId);
  const branchDevices = devices.filter((d) => d.branchId === branchId);
  const candidate = chosenDevice ?? savedDevice;
  const deviceId = branchDevices.some((d) => d.id === candidate)
    ? candidate
    : "";
  const mode = branch?.checkoutEnabled ? chosenMode : "CHECK_IN";

  const submit = useCallback(
    (payload: string) => {
      const value = payload.trim();
      if (!value || busyRef.current) return;
      // The camera sees the same code many times a second; send it once.
      const last = lastRef.current;
      if (last && last.value === value && Date.now() - last.at < 4000) return;
      lastRef.current = { value, at: Date.now() };
      busyRef.current = true;
      setError(null);
      startTransition(async () => {
        const res = await scanAction({
          payload: value,
          branchId,
          deviceId: deviceId || undefined,
          type: mode,
        });
        busyRef.current = false;
        if (res.ok) {
          setResult(res.data);
          if ("vibrate" in navigator)
            navigator.vibrate(
              res.data.result === "ACCEPTED" ? 80 : [80, 60, 80],
            );
        } else setError(res.error.message);
      });
    },
    [branchId, deviceId, mode],
  );

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("off");
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  async function startCamera() {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        "This browser can't use the camera here. Use a USB/Bluetooth scanner or type the code.",
      );
      return;
    }
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setCamera("on");
      void decodeLoop();
    } catch (err) {
      setCamera("off");
      const name = err instanceof DOMException ? err.name : "";
      setCameraError(
        name === "NotAllowedError"
          ? "Camera access is blocked. Allow it in the browser's site settings, or use a scanner / type the code."
          : name === "NotFoundError"
            ? "No camera found on this device. Use a scanner or type the code."
            : "The camera couldn't start. Try again, or use a scanner.",
      );
    }
  }

  async function decodeLoop() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let detector: Detector | null = null;
    if (window.BarcodeDetector) {
      try {
        detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch {
        detector = null;
      }
    }
    const jsQR = detector ? null : (await import("jsqr")).default;
    const tick = async () => {
      if (!streamRef.current || !video.videoWidth) {
        if (streamRef.current) setTimeout(tick, 200);
        return;
      }
      try {
        let value: string | null = null;
        if (detector) {
          const codes = await detector.detect(video);
          value = codes[0]?.rawValue ?? null;
        } else if (context && jsQR) {
          // Scale down: decoding a 640px frame is plenty for a phone-held QR.
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          value =
            jsQR(image.data, image.width, image.height, {
              inversionAttempts: "dontInvert",
            })?.data ?? null;
        }
        if (value) submit(value);
      } catch {
        // A bad frame: try the next one.
      }
      setTimeout(tick, 150);
    };
    void tick();
  }

  // Manual check-in
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);
  const [reason, setReason] = useState("");
  const [manual, setManual] = useState<ScanResult | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [checking, startCheck] = useTransition();

  const searchable = query.trim().length >= 2;
  const results = searchable ? found : [];
  useEffect(() => {
    if (!searchable) return;
    const t = setTimeout(() => {
      startSearch(async () => {
        const res = await searchMembersAction(query);
        setFound(res.ok ? res.data : []);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query, searchable]);

  function checkInManually(override: boolean) {
    if (!picked) return;
    setManualError(null);
    startCheck(async () => {
      const res = await manualCheckInAction({
        memberId: picked.id,
        branchId,
        reason,
        override,
        type: mode,
        deviceId: deviceId || undefined,
      });
      if (res.ok) {
        setManual(res.data);
        setResult(res.data);
      } else setManualError(res.error.message);
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Branch
              <select
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  setChosenDevice(null);
                }}
                className="h-10 rounded-md border border-border bg-surface px-2"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              This scanner
              <select
                value={deviceId}
                onChange={(e) => {
                  setChosenDevice(e.target.value);
                  try {
                    localStorage.setItem(DEVICE_KEY, e.target.value);
                  } catch {
                    /* ignore */
                  }
                }}
                className="h-10 rounded-md border border-border bg-surface px-2"
              >
                <option value="">Not named</option>
                {branchDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {branch?.checkoutEnabled && (
            <div role="radiogroup" aria-label="Mode" className="flex gap-2">
              {(["CHECK_IN", "CHECK_OUT"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  variant={mode === m ? "primary" : "outline"}
                  size="sm"
                  onClick={() => setMode(m)}
                >
                  {m === "CHECK_IN" ? "Check in" : "Check out"}
                </Button>
              ))}
            </div>
          )}
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video
              ref={videoRef}
              muted
              playsInline
              aria-label="Camera preview"
              className={`aspect-square w-full object-cover ${camera === "on" ? "" : "hidden"}`}
            />
            {camera !== "on" && (
              <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 p-6 text-center text-white/80">
                <Camera aria-hidden="true" className="size-10" />
                <p className="text-sm">
                  {camera === "starting"
                    ? "Starting the camera…"
                    : "Use this device's camera to scan."}
                </p>
              </div>
            )}
          </div>
          {cameraError && <Alert tone="warning">{cameraError}</Alert>}
          {camera === "on" ? (
            <Button type="button" variant="outline" onClick={stopCamera}>
              <CameraOff aria-hidden="true" className="size-4" /> Stop camera
            </Button>
          ) : (
            <Button
              type="button"
              onClick={startCamera}
              loading={camera === "starting"}
            >
              <Camera aria-hidden="true" className="size-4" /> Start camera
            </Button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              lastRef.current = null; // typed/wedge input is always deliberate
              submit(wedge);
              setWedge("");
            }}
            className="flex flex-col gap-1.5"
          >
            <label htmlFor="wedge" className="text-sm font-medium">
              Scanner input
            </label>
            <div className="flex gap-2">
              <input
                id="wedge"
                name="payload"
                value={wedge}
                onChange={(e) => setWedge(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Scan with a USB/Bluetooth scanner, or paste a code"
                className="h-10 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm"
              />
              <Button type="submit" loading={pending}>
                Check
              </Button>
            </div>
            <p className="text-xs text-muted">
              Hardware scanners type the code and press Enter; keep this box
              focused.
            </p>
          </form>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <section aria-live="assertive" aria-label="Scan result">
          {error && <Alert tone="danger">{error}</Alert>}
          {result ? (
            <ResultPanel result={result} />
          ) : (
            <Card>
              <CardTitle>Waiting for a scan</CardTitle>
              <p className="mt-2 text-sm text-muted">
                The member opens Card in their app; the code refreshes every 30
                seconds. Screenshots don't work.
              </p>
            </Card>
          )}
        </section>

        <Card className="flex flex-col gap-3">
          <CardTitle>Check in by hand</CardTitle>
          <p className="text-sm text-muted">
            Forgot phone? Find the member, give a reason. The same rules apply
            and it is recorded with your name.
          </p>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Find member
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPicked(null);
                setManual(null);
              }}
              placeholder="Name, member code or phone"
              className="h-10 rounded-md border border-border bg-surface px-3"
            />
          </label>
          {searching && <p className="text-xs text-muted">Searching…</p>}
          {!picked && results.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {results.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(m)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-background"
                  >
                    <span className="font-medium">{m.name}</span>
                    <span className="text-xs text-muted">
                      {m.memberCode}
                      {m.phoneLast4 ? ` · …${m.phoneLast4}` : ""} · {m.branch}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!picked && searchable && !searching && results.length === 0 && (
            <p className="text-sm text-muted">No members match.</p>
          )}
          {picked && (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                <span className="font-medium">{picked.name}</span> ·{" "}
                {picked.memberCode}
              </p>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Reason
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. forgot phone"
                  className="h-10 rounded-md border border-border bg-surface px-3"
                />
              </label>
              {manualError && <Alert tone="danger">{manualError}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  loading={checking}
                  onClick={() => checkInManually(false)}
                >
                  {mode === "CHECK_OUT" ? "Check out" : "Check in"}
                </Button>
                {manual?.overridable && canOverride && (
                  <Button
                    type="button"
                    variant="danger"
                    loading={checking}
                    onClick={() => checkInManually(true)}
                  >
                    Check in anyway (override)
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
