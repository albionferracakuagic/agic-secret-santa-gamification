import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GIFT_MAX_PHOTO_BYTES } from '@santa/contracts';
import { hasApiCode } from '../../api/client';
import { usePlayApi } from '../../api/play';
import { avatarGlyph } from '../../fx/avatars';
import { emitFx } from '../../fx/bus';
import { GiftPhoto, GiftPhotoPreview, safePhotoUrl } from '../GiftPhoto';

const field = 'mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3';
export { safePhotoUrl } from '../GiftPhoto';
const errKey = (e: unknown) => {
  for (const code of ['gift_locked', 'invalid_image', 'file_too_large'] as const)
    if (hasApiCode(e, code)) return `gift.error.${code}`;
  return 'error.generic';
};

/** Gift registration: name, description, photo with client-side preview. Before opening only the giver sees the content. */
export function GiftForm({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const api = usePlayApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gift'], queryFn: () => api.getGift() });
  const gift = q.data?.gift ?? null;
  const editable = canEdit && (q.data?.editable ?? false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File>();
  const [fileErr, setFileErr] = useState<string>();
  const [saved, setSaved] = useState(false);

  const giftId = gift?.giftId;
  useEffect(() => {
    if (gift) {
      setName(gift.name);
      setDescription(gift.description ?? '');
    }
  }, [giftId]);

  const save = useMutation({
    mutationFn: async () => {
      let r = await api.saveGift({ name: name.trim(), description: description.trim() || null });
      if (file) r = await api.uploadPhoto(file);
      return r;
    },
    onSuccess: (r) => {
      qc.setQueryData(['gift'], r);
      setFile(undefined);
      setSaved(true);
      emitFx('gift_registered');
    },
  });
  const removePhoto = useMutation({
    mutationFn: () => api.removePhoto(),
    onSuccess: (r) => qc.setQueryData(['gift'], r),
  });

  const pick = (f: File | undefined) => {
    setFileErr(undefined);
    if (!f) return setFile(undefined);
    if (!f.type.startsWith('image/')) return setFileErr('gift.error.invalid_image');
    if (f.size > GIFT_MAX_PHOTO_BYTES) return setFileErr('gift.error.file_too_large');
    setFile(f);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate();
  };

  const serverPhoto = file ? undefined : safePhotoUrl(gift?.photoUrl);
  return (
    <section aria-labelledby="gift-title" className="space-y-3">
      <h2 id="gift-title" className="font-semibold">
        {t('gift.title')}
      </h2>
      {!editable && gift && <p>{t('gift.locked')}</p>}
      {!editable && !gift && <p>{t('gift.notOpen')}</p>}
      {(editable || gift) && (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            {t('gift.name')}
            <input
              className={field}
              value={name}
              maxLength={80}
              disabled={!editable}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            {t('gift.description')}
            <textarea
              className={`${field} py-2`}
              rows={3}
              value={description}
              maxLength={500}
              disabled={!editable}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {editable && (
            <label className="block">
              {t('gift.photo')}
              <input
                type="file"
                accept="image/*"
                className="mt-1 block min-h-12 w-full"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </label>
          )}
          {fileErr && <p role="alert">{t(fileErr)}</p>}
          {(file || serverPhoto) && (
            <div className="space-y-2">
              {file && (
                <GiftPhotoPreview
                  file={file}
                  alt={t('gift.photoAlt')}
                  className="h-40 rounded-xl object-cover"
                />
              )}
              {serverPhoto && (
                <GiftPhoto
                  src={serverPhoto}
                  alt={t('gift.photoAlt')}
                  className="h-40 rounded-xl object-cover"
                  testId="gift-photo"
                />
              )}
              {editable && !file && gift?.photoUrl && (
                <button
                  type="button"
                  className="min-h-12 rounded border border-ink-900 px-4"
                  onClick={() => removePhoto.mutate()}
                >
                  {t('gift.removePhoto')}
                </button>
              )}
            </div>
          )}
          {editable && (
            <button
              className="min-h-12 rounded bg-santa-600 px-4 font-semibold text-white disabled:opacity-60"
              disabled={name.trim().length === 0 || save.isPending}
            >
              {t(gift ? 'gift.update' : 'gift.register')}
            </button>
          )}
          <p role="status">{saved && !save.isPending ? t('gift.saved') : ''}</p>
          {(save.isError || removePhoto.isError) && (
            <p role="alert">{t(errKey(save.error ?? removePhoto.error))}</p>
          )}
        </form>
      )}
    </section>
  );
}

/** Who the caller gives to. Needs a verified claim: otherwise a friendly pointer to verify. */
export function AssignmentView() {
  const { t } = useTranslation();
  const api = usePlayApi();
  const q = useQuery({ queryKey: ['assignment'], queryFn: () => api.assignment(), retry: false });
  if (q.isLoading) return null;
  if (hasApiCode(q.error, 'verification_required'))
    return <p role="status">{t('assignment.verify')}</p>;
  if (!q.data) return <p role="status">{t('assignment.none')}</p>;
  return <RecipientReveal recipient={q.data.recipient} />;
}

type Recipient = { participantId: string; displayName: string; avatar: string | null };

/** Recipient details stay out of the DOM until the participant explicitly chooses to reveal them. */
export function RecipientReveal({
  recipient,
  pastTense = false,
}: {
  recipient: Recipient;
  pastTense?: boolean;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const detailsId = useId();
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="min-h-12 rounded border border-ink-900 px-4 font-semibold"
        aria-expanded={revealed}
        aria-controls={revealed ? detailsId : undefined}
        onClick={() => setRevealed((value) => !value)}
      >
        {t(revealed ? 'assignment.hide' : 'assignment.reveal')}
      </button>
      {revealed && (
        <section id={detailsId} aria-live="polite" className="space-y-1">
          <p className="font-semibold">
            {t(pastTense ? 'recap.gaveTo' : 'assignment.title')}
          </p>
          <p className="text-xl">
            <span aria-hidden="true">{avatarGlyph(recipient.avatar)}</span>{' '}
            {recipient.displayName}
          </p>
          <p className="text-sm">{t('assignment.secret')}</p>
        </section>
      )}
    </div>
  );
}
