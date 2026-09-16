export function ratingClass(rating) {
  return rating >= 4000 ? 'tourist' : rating >= 3000 ? 'legendary' : rating >= 2400 ? 'red' : rating >= 2100 ? 'orange' : rating >= 1900 ? 'violet' : rating >= 1600 ? 'blue' : rating >= 1400 ? 'cyan' : rating >= 1200 ? 'green' : 'gray';
}
export function colorRating(element, rating) {
  element.classList.add('cf-rated');
  element.dataset.cf = ratingClass(Number(rating) || 0);
  return element;
}
