import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GIFT_MAX_PHOTO_BYTES } from '@santa/contracts';
import { hasApiCode } from '../../api/client';
import { usePlayApi } from '../../api/play';
import { avatarGlyph } from '../../fx/avatars';
import { emitFx } from '../../fx/bus';

const field = 'mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3';
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

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

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

  const shownPhoto = preview ?? gift?.photoUrl ?? undefined;
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
          {shownPhoto && (
            <div className="space-y-2">
              <img
                src={shownPhoto}
                alt={t('gift.photoAlt')}
                className="h-40 rounded-xl object-cover"
                data-testid="gift-photo"
              />
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
  const r = q.data.recipient;
  return (
    <section aria-labelledby="assign-title" className="space-y-1">
      <h2 id="assign-title" className="font-semibold">
        {t('assignment.title')}
      </h2>
      <p className="text-xl">
        <span aria-hidden="true">{avatarGlyph(r.avatar)}</span> {r.displayName}
      </p>
      <p className="text-sm">{t('assignment.secret')}</p>
    </section>
  );
}
