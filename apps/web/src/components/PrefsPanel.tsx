import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { setLocale, type AppLocale } from '../i18n';
import { usePrefs, type Intensity, type ReducedMotionPref } from '../prefs/store';
import { unlockAudio } from '../fx/audio';

const INTENSITIES: Intensity[] = ['off', 'low', 'normal', 'high'];
const MOTION: ReducedMotionPref[] = ['system', 'on', 'off'];

export function PrefsPanel() {
  const { t, i18n } = useTranslation();
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const field =
    'mt-1 block min-h-11 w-full rounded border border-ink-900/40 bg-white px-2 text-ink-900';

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        className="min-h-11 rounded border border-white/70 px-3"
        onClick={() => setOpen((o) => !o)}
      >
        {t('prefs.title')}
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={t('prefs.title')}
          className="absolute right-0 z-40 mt-2 w-72 space-y-3 rounded bg-white p-4 text-ink-900 shadow-lg"
        >
          <label className="block">
            {t('prefs.language')}
            <select
              className={field}
              value={i18n.language}
              onChange={(e) => setLocale(e.target.value as AppLocale)}
            >
              <option value="en">English</option>
              <option value="it">Italiano</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={prefs.sound}
              onChange={(e) => {
                if (e.target.checked) unlockAudio();
                prefs.set({ sound: e.target.checked });
              }}
            />
            {t('prefs.sound')}
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={prefs.music}
              onChange={(e) => {
                if (e.target.checked) unlockAudio();
                prefs.set({ music: e.target.checked });
              }}
            />
            {t('prefs.music')}
          </label>
          <label className="block">
            {t('prefs.intensity')}
            <select
              className={field}
              value={prefs.intensity}
              onChange={(e) => prefs.set({ intensity: e.target.value as Intensity })}
            >
              {INTENSITIES.map((i) => (
                <option key={i} value={i}>
                  {t(`prefs.intensityLevel.${i}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            {t('prefs.reducedMotion')}
            <select
              className={field}
              value={prefs.reducedMotion}
              onChange={(e) => prefs.set({ reducedMotion: e.target.value as ReducedMotionPref })}
            >
              {MOTION.map((m) => (
                <option key={m} value={m}>
                  {t(m === 'system' ? 'prefs.system' : m === 'on' ? 'prefs.on' : 'prefs.off')}
                </option>
              ))}
            </select>
          </label>
          <Link to="/credits" className="block min-h-11 underline" onClick={() => setOpen(false)}>
            {t('credits.link')}
          </Link>
        </div>
      )}
    </div>
  );
}
