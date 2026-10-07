export function ratingClass(rating) {
  const value = Math.max(0, Math.min(8000, Number(rating) || 0));
  if (value >= 5000) return 'gold-red';
  if (value >= 3500) return 'silver-red';
  if (value >= 3200) return 'copper-red';
  if (value >= 3000) return 'black-red';
  if (value >= 2400) return 'red';
  if (value >= 2100) return 'orange';
  if (value >= 1900) return 'violet';
  if (value >= 1600) return 'blue';
  if (value >= 1400) return 'cyan';
  if (value >= 1200) return 'green';
  return 'gray';
}
export function colorRating(element, rating) {
  element.classList.add('cf-rated');
  element.dataset.cf = ratingClass(Number(rating) || 0);
  return element;
}
export function colorUnrated(element) {
  element.classList.add('cf-unrated');
  return element;
}
