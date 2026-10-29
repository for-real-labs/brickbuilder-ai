import React, { useEffect, useState } from "react";
import FallingBricks from "../components/FallingBricks";

const INVITATION = "use for free at";
const ADDRESS = "trybrickbuilder.com";

export default function VideoPage() {
  const [frame, setFrame] = useState({ invitation: 0, address: 0 });

  useEffect(() => {
    let invitation = 0;
    let address = 0;
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      if (invitation < INVITATION.length) {
        invitation += 1;
        setFrame({ invitation, address });
        timer = setTimeout(advance, invitation === INVITATION.length ? 380 : 100);
      } else if (address < ADDRESS.length) {
        address += 1;
        setFrame({ invitation, address });
        timer = setTimeout(advance, address === ADDRESS.length ? 3000 : 80);
      } else {
        invitation = 0;
        address = 0;
        setFrame({ invitation, address });
        timer = setTimeout(advance, 100);
      }
    };
    timer = setTimeout(advance, 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen relative flex items-center justify-center overflow-hidden" style={{ backgroundColor: "#fbfbfd" }}>
      <FallingBricks density={50} opacity={0.3} zIndex={0} />
      <div className="relative flex flex-col items-center gap-4 px-4" style={{ zIndex: 10 }}>
        <p className="relative text-lg text-slate-600 font-medium" aria-label={INVITATION.slice(0, frame.invitation)}>
          {INVITATION.split("").map((char, i) => (
            <span key={i} aria-hidden="true" style={{ visibility: i < frame.invitation ? "visible" : "hidden" }}>{char}</span>
          ))}
        </p>
        <p className="text-2xl sm:text-4xl font-extrabold tracking-tight whitespace-nowrap" aria-label={ADDRESS.slice(0, frame.address)}>
          {ADDRESS.split("").map((char, i) => (
            <span key={i} aria-hidden="true" style={{
              visibility: i < frame.address ? "visible" : "hidden",
              color: (i >= 3 && i < 8) || i >= 15 ? "#ff4b4b" : "#0f172a",
            }}>{char}</span>
          ))}
        </p>
      </div>
    </div>
  );
}
