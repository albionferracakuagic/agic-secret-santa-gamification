import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GiftPhoto, GiftPhotoPreview, safePhotoUrl } from './GiftPhoto';

describe('gift photo URLs', () => {
  it('normalizes relative media URLs and keeps signed HTTPS URLs', () => {
    expect(safePhotoUrl('/media/gifts/e1/a.jpg?exp=10&sig=test')).toBe(
      new URL('/media/gifts/e1/a.jpg?exp=10&sig=test', window.location.origin).href,
    );
    expect(
      safePhotoUrl(
        'https://account.blob.core.windows.net/gifts/e1/a.jpg?sv=1&se=2026-12-20&sig=signed',
      ),
    ).toBe('https://account.blob.core.windows.net/gifts/e1/a.jpg?sv=1&se=2026-12-20&sig=signed');
  });

  it('rejects unsafe and malformed server values', () => {
    expect(safePhotoUrl('javascript:alert(1)')).toBeUndefined();
    expect(safePhotoUrl('http://remote.example/photo.jpg')).toBeUndefined();
    expect(safePhotoUrl('http://[')).toBeUndefined();
  });

  it('shows a fallback when an image cannot load', () => {
    render(
      <GiftPhoto
        src="/media/gifts/e1/missing.jpg?exp=10&sig=test"
        alt="Gift"
        className="photo"
        testId="photo"
        fallback={<span data-testid="fallback">🎁</span>}
      />,
    );
    const photo = screen.getByTestId('photo');
    fireEvent.error(photo);
    expect(screen.queryByTestId('photo')).toBeNull();
    expect(screen.getByTestId('fallback')).toBeTruthy();
  });

  it('renders blob previews and revokes them on unmount', async () => {
    const createObjectURL = vi.fn(() => 'blob:gift-preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const imagePart: BlobPart = 'image';
    const file = new File([imagePart], 'gift.jpg', { type: 'image/jpeg' });

    const view = render(
      <GiftPhotoPreview file={file} alt="Preview" className="preview" />,
    );
    expect((await screen.findByTestId('gift-photo-preview')).getAttribute('src')).toBe(
      'blob:gift-preview',
    );
    expect(createObjectURL).toHaveBeenCalledWith(file);

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gift-preview');
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });
});
