// PROTOTYPE (#30): there is no video file to hand, so one is recorded from a canvas once,
// as the page loads, and played as if the Daemon had streamed it through.
let recorded: Promise<string | undefined> | undefined;

const record = async (): Promise<string | undefined> => {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (context === null) {
    return undefined;
  }
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const started = performance.now();
  const dots = Array.from({ length: 14 }, (_, index) => ({
    r: 6 + ((index * 7) % 22),
    x: (index * 97) % 640,
    y: 80 + ((index * 53) % 220),
  }));
  const draw = () => {
    const t = (performance.now() - started) / 1000;
    const gradient = context.createRadialGradient(320, 200, 20, 320, 200, 420);
    gradient.addColorStop(0, "#3a6b5a");
    gradient.addColorStop(1, "#0d1a17");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 640, 360);
    for (const dot of dots) {
      const glow = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + dot.x));
      context.fillStyle = `rgba(207, 232, 213, ${glow})`;
      context.beginPath();
      context.arc((dot.x + t * 30) % 660, dot.y + Math.sin(t + dot.r) * 10, dot.r, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = "#081210";
    context.fillRect(0, 300, 640, 60);
  };
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  const timer = setInterval(draw, 1000 / 30);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  clearInterval(timer);
  recorder.stop();
  await done;
  return URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
};

export const videoUrl = (): Promise<string | undefined> => {
  recorded ??= record().catch(() => undefined);
  return recorded;
};
