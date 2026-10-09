import React from 'react';
import { Info, Package, X } from 'lucide-react';
import QRCode from 'qrcode';
import posthog from 'posthog-js';

export function getPostcardTheme(name: string) {
  if (/\b(space|galaxy|cosmic|star|rocket|planet|moon)\b/i.test(name)) return 'space';
  if (/\b(ocean|sea|beach|water|boat|ship|island|coral)\b/i.test(name)) return 'ocean';
  if (/\b(forest|garden|tree|flower|plant|mountain|cottage|nature)\b/i.test(name)) return 'nature';
  if (/\b(city|skyline|building|tower|street|house|castle)\b/i.test(name)) return 'architecture';
  return 'studio';
}

function InstructionsQrCode({ url }: { url: string }) {
  const { size, path } = React.useMemo(() => {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const cells: string[] = [];
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`);
      }
    }
    return { size: modules.size + 8, path: cells.join('') };
  }, [url]);
  return <svg role="img" aria-label="QR code linking to this model’s instructions" viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" />
    <path d={path} fill="#17202a" />
  </svg>;
}

export function InstructionsPostcard({ selected, onChange, disabled, modelName, modelImage, generationId }: {
  selected: boolean; onChange: (selected: boolean) => void; disabled: boolean;
  modelName: string; modelImage: string | null; generationId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [failedImage, setFailedImage] = React.useState<string | null>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const infoButton = React.useRef<HTMLButtonElement>(null);
  const descriptionId = React.useId();
  const instructionsUrl = `https://brickbuilder.ai/instructions?id=${encodeURIComponent(generationId)}`;
  const image = modelImage && modelImage !== failedImage ? modelImage : null;

  React.useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  const close = () => dialog.current?.close();

  return <div className={`checkout-postcard-option ${selected ? 'is-selected' : ''}`}>
    <label><input type="checkbox" name="shipInstructionsPostcard" checked={selected} disabled={disabled} onChange={event => {
      onChange(event.target.checked);
      posthog.capture('order_instructions_postcard_changed', { generation_id: generationId, selected: event.target.checked });
    }} /><span>ship instructions post card</span></label>
    <button ref={infoButton} type="button" disabled={disabled} className="checkout-postcard-info" aria-label="About the instructions post card" aria-haspopup="dialog" aria-expanded={open} onClick={() => {
      setOpen(true);
      posthog.capture('order_instructions_postcard_preview_opened', { generation_id: generationId });
    }}><Info size={19} aria-hidden="true" /></button>
    <dialog ref={dialog} className="checkout-postcard-dialog" aria-label="Instructions post card preview" aria-describedby={descriptionId}
      onClick={event => { if (event.target === event.currentTarget) close(); }}
      onCancel={event => { event.preventDefault(); close(); }}
      onClose={() => {
        setOpen(false); infoButton.current?.focus();
        posthog.capture('order_instructions_postcard_preview_closed', { generation_id: generationId });
      }}>
      <div className="checkout-postcard-dialog-content">
        <button type="button" className="checkout-postcard-close" aria-label="Close postcard preview" onClick={close}><X size={20} aria-hidden="true" /></button>
        <p id={descriptionId} className="checkout-postcard-description">Select this option to ship a post card with a QR code link to the instructions.</p>
        <figure className="checkout-postcard-example" aria-label="6 by 4 inch instructions postcard">
          <div className={`checkout-postcard checkout-postcard-${getPostcardTheme(modelName)}`}>
            <div className="checkout-postcard-art">
              <span className="checkout-postcard-brand">BRICKBUILDER</span>
              {image ? <img src={image} alt={`${modelName} model on the example postcard`} onError={() => setFailedImage(image)} /> : <div className="checkout-postcard-placeholder"><Package size={38} aria-hidden="true" /><span>Model preview unavailable</span></div>}
              <span className="checkout-postcard-art-caption">Made to be built.</span>
            </div>
            <div className="checkout-postcard-details">
              <span className="checkout-postcard-edition">YOUR CUSTOM BUILD</span>
              <h3 title={modelName}>{modelName}</h3>
              <a className="checkout-postcard-qr" href={instructionsUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open instructions for ${modelName}`} onClick={() => posthog.capture('order_instructions_postcard_link_clicked', { generation_id: generationId })}><InstructionsQrCode url={instructionsUrl} /></a>
              <span className="checkout-postcard-scan">Scan to start building</span>
              <span className="checkout-postcard-site">brickbuilder.ai</span>
            </div>
          </div>
        </figure>
        <button type="button" className="checkout-primary" onClick={close}>Got it</button>
      </div>
    </dialog>
  </div>;
}
