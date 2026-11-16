import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { effectiveIntensity, usePrefs } from '../prefs/store';
import { useFxCap } from './cap';
import { setFxEngine, setAmbient } from './bus';
import { createFxEngine } from './engine';
import { createDomHost } from './host';
import { setMusic } from './audio';

/**
 * Non-blocking overlay: portal to <body>, pointer-events:none, decorative layers aria-hidden.
 * Text equivalents go to an ARIA-live region (and a visible caption when visuals are off).
 */
export function FxOverlay() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const cap = useFxCap((s) => s.cap);
  const [caption, setCaption] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const snow = useRef<HTMLCanvasElement>(null);
  const conf = useRef<HTMLCanvasElement>(null);
  const lights = useRef<HTMLDivElement>(null);
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);
  const visualsOff = effectiveIntensity(prefs, cap) === 'off';

  useEffect(() => {
    if (!root.current || !snow.current || !conf.current || !lights.current) return;
    const host = createDomHost({
      root: root.current,
      snowCanvas: snow.current,
      confettiCanvas: conf.current,
      lightsEl: lights.current,
      announce: (text) => {
        setCaption(text);
        clearTimeout(clear.current);
        clear.current = setTimeout(() => setCaption(''), 3500);
      },
      onSlow: () => useFxCap.getState().degrade(),
    });
    const engine = createFxEngine({
      host,
      getPrefs: () => usePrefs.getState(),
      getCap: () => useFxCap.getState().cap,
      translate: (k) => t(k),
    });
    setFxEngine(engine);
    engine.setAmbient(true);
    return () => {
      setFxEngine(undefined);
      host.dispose();
    };
  }, [t]);

  useEffect(() => {
    void setMusic(prefs.music);
  }, [prefs.music]);

  useEffect(() => {
    setAmbient(true); // re-evaluate snow/lights when intensity, reduced-motion or auto-cap change
  }, [prefs.intensity, prefs.reducedMotion, cap]);

  return createPortal(
    <>
      <div ref={root} className="fx-root" data-testid="fx-root">
        <canvas ref={snow} aria-hidden="true" className="absolute inset-0 h-full w-full" />
        <canvas ref={conf} aria-hidden="true" className="absolute inset-0 h-full w-full" />
        <div ref={lights} aria-hidden="true" className="fx-lights" style={{ display: 'none' }} />
        {visualsOff && caption && (
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-ink-900 px-4 py-2 text-white">
            {caption}
          </p>
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {caption}
      </div>
    </>,
    document.body,
  );
}
