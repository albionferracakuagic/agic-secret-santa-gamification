import { useEffect, useId, useState, type DragEvent, type FormEvent } from 'react';
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
  const [draggingPhoto, setDraggingPhoto] = useState(false);
  const photoInputId = useId();
  const photoHelpId = useId();

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
  const dropPhoto = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingPhoto(false);
    pick(e.dataTransfer.files?.[0]);
  };
  const clearSelectedPhoto = () => {
    setFile(undefined);
    setFileErr(undefined);
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
            <div className="space-y-2">
              <p className="font-semibold">{t('gift.photo')}</p>
              <div
                role="group"
                aria-label={t('gift.photoUpload')}
                data-testid="gift-photo-dropzone"
                className={`photo-upload rounded-2xl border-2 border-dashed p-4 transition-colors ${
                  draggingPhoto
                    ? 'border-pine-700 bg-pine-900/5'
                    : 'border-ink-900/35 bg-white'
                }`}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDraggingPhoto(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDraggingPhoto(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    setDraggingPhoto(false);
                }}
                onDrop={dropPhoto}
              >
                <input
                  id={photoInputId}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label={t('gift.photo')}
                  aria-describedby={photoHelpId}
                  onClick={(e) => {
                    e.currentTarget.value = '';
                  }}
                  onChange={(e) => pick(e.target.files?.[0])}
                />
                {(file || serverPhoto) && (
                  <div className="mb-3">
                    {file && (
                      <GiftPhotoPreview
                        file={file}
                        alt={t('gift.photoAlt')}
                        className="h-44 w-full rounded-xl object-cover"
                      />
                    )}
                    {serverPhoto && (
                      <GiftPhoto
                        src={serverPhoto}
                        alt={t('gift.photoAlt')}
                        className="h-44 w-full rounded-xl object-cover"
                        testId="gift-photo"
                      />
                    )}
                    {file && (
                      <p className="mt-2 break-words text-sm" role="status">
                        {t('gift.selectedPhoto', { name: file.name })}
                      </p>
                    )}
                  </div>
                )}
                {!file && !serverPhoto && (
                  <div className="mb-3 text-center">
                    <p className="font-semibold">{t('gift.photoDrop')}</p>
                  </div>
                )}
                <p id={photoHelpId} className="mb-3 text-center text-sm">
                  {t('gift.photoHelp', { size: 5 })}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <label
                    htmlFor={photoInputId}
                    className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg bg-santa-600 px-5 font-semibold text-white hover:bg-santa-700"
                  >
                    {t(file || serverPhoto ? 'gift.replacePhoto' : 'gift.choosePhoto')}
                  </label>
                  {(file || gift?.photoUrl) && (
                    <button
                      type="button"
                      className="min-h-12 rounded-lg border border-ink-900 px-5 font-semibold"
                      disabled={removePhoto.isPending}
                      onClick={() => (file ? clearSelectedPhoto() : removePhoto.mutate())}
                    >
                      {t('gift.removePhoto')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {fileErr && <p role="alert">{t(fileErr)}</p>}
          {!editable && serverPhoto && (
            <div className="space-y-2">
              <GiftPhoto
                src={serverPhoto}
                alt={t('gift.photoAlt')}
                className="h-40 rounded-xl object-cover"
                testId="gift-photo"
              />
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
