// Tailwind CSS build configuration.
//
// The frontend uses a pre-built stylesheet (frontend/css/tailwind.css) instead
// of the Tailwind play CDN, so pages no longer depend on a third-party script
// and the CSS is not compiled in every visitor's browser.
//
// Rebuild after adding or changing Tailwind classes in any page or script:
//   tailwindcss -c tailwind.config.js -i frontend/css/tailwind.input.css \
//               -o frontend/css/tailwind.css --minify
// (Tailwind v3 standalone CLI: https://github.com/tailwindlabs/tailwindcss/releases/tag/v3.4.17)

const sectionColours = ['orange', 'blue', 'green', 'purple', 'teal', 'rose'];

module.exports = {
  content: ['./frontend/**/*.html', './frontend/js/**/*.js'],
  // admin.js builds these class names at runtime (`bg-${col}-100` etc.) for the
  // question-bank section cards, so the scanner cannot see them.
  safelist: sectionColours.flatMap(c => [
    `bg-${c}-50`, `bg-${c}-100`, `border-${c}-100`, `border-${c}-200`,
    `text-${c}-400`, `text-${c}-600`,
  ]),
  theme: { extend: {} },
  plugins: [],
};
