// Built-in targets. Each `html` fills the 600×400 canvas exactly.

const starter = `<style>
  /* Plain CSS works here, Tailwind classes work too. Mix as you like. */
</style>
<div class="w-[600px] h-[400px] bg-white">
  <!-- Build the target here -->
</div>`;

export const builtInChallenges = [
  {
    slug: "prompt-input-card",
    title: "Prompt input card",
    html: `<div class="w-[600px] h-[400px] bg-white flex flex-col items-center justify-center px-12">
  <h1 class="text-[28px] leading-tight font-bold text-neutral-900 text-center">
    What do you want to <span class="text-[#a855f7]">hallucinate</span> today?
  </h1>
  <p class="mt-2 text-sm text-neutral-500">Your bugs, delivered faster</p>
  <div class="relative mt-6 w-full h-28 rounded-xl bg-[#5c6656] p-4">
    <p class="text-sm text-neutral-200">Describe your billion dollar idea...</p>
    <div class="absolute bottom-3 right-3 w-8 h-8 rounded-lg bg-[#f59e0b] flex items-center justify-center text-white font-bold">↑</div>
  </div>
  <div class="mt-5 flex gap-2">
    <span class="px-3 py-1 rounded-full bg-[#1e202d] text-white text-xs">↑ Technical debt</span>
    <span class="px-3 py-1 rounded-full bg-[#1e202d] text-white text-xs">↑ Spaghetti code</span>
    <span class="px-3 py-1 rounded-full bg-[#1e202d] text-white text-xs">↑ It works locally</span>
  </div>
</div>`,
  },
  {
    slug: "stats-widget",
    title: "Stats widget",
    html: `<div class="w-[600px] h-[400px] bg-[#0f172a] p-10 flex flex-col">
  <div class="flex items-center justify-between">
    <p class="text-sm font-medium text-slate-400">Monthly revenue</p>
    <span class="px-2 py-0.5 rounded-md bg-slate-800 text-xs text-slate-200">Last 7 days</span>
  </div>
  <div class="mt-3 flex items-end gap-3">
    <p class="text-6xl font-bold text-white">$48.2k</p>
    <span class="mb-2 px-2 py-0.5 rounded-full bg-[#134e4a] text-[#5eead4] text-sm font-semibold">+12.4%</span>
  </div>
  <div class="mt-auto flex items-end gap-4 h-40">
    <div class="flex-1 h-[40%] rounded-t-md bg-[#334155]"></div>
    <div class="flex-1 h-[55%] rounded-t-md bg-[#334155]"></div>
    <div class="flex-1 h-[35%] rounded-t-md bg-[#334155]"></div>
    <div class="flex-1 h-[70%] rounded-t-md bg-[#334155]"></div>
    <div class="flex-1 h-[60%] rounded-t-md bg-[#334155]"></div>
    <div class="flex-1 h-[85%] rounded-t-md bg-[#334155]"></div>
    <div class="flex-1 h-full rounded-t-md bg-[#38bdf8]"></div>
  </div>
</div>`,
  },
  {
    slug: "pricing-card",
    title: "Pricing card",
    html: `<div class="w-[600px] h-[400px] bg-[#f1f5f9] flex items-center justify-center">
  <div class="w-[320px] rounded-2xl bg-white border border-slate-200 p-7">
    <p class="text-sm font-semibold text-indigo-600">Pro</p>
    <p class="mt-2 text-4xl font-bold text-slate-900">$29<span class="text-base font-medium text-slate-500"> / month</span></p>
    <ul class="mt-5 space-y-2 text-sm text-slate-700">
      <li>✓ Unlimited projects</li>
      <li>✓ Custom domains</li>
      <li>✓ Priority support</li>
      <li>✓ Team analytics</li>
    </ul>
    <div class="mt-6 w-full rounded-lg bg-slate-900 py-2.5 text-center text-sm font-semibold text-white">Start free trial</div>
  </div>
</div>`,
  },
].map((c) => ({ ...c, starterCode: starter }));

export const uploadStarter = starter;
