// /scenes.html: one card per entry in the scene registry, each a link that
// boots the scene straight into play.

import { sceneHref, SCENES, type Scene } from './registry'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const card = (scene: Scene): HTMLLIElement => {
  const a = el('a', 'sf-scene')
  a.href = sceneHref(scene.name)
  a.dataset.scene = scene.name
  const head = el('div', 'sf-scene__head')
  head.append(el('span', 'sf-scene__title', scene.title), el('span', 'sf-scene__play', 'PLAY ▶'))
  const tryLine = el('p', 'sf-scene__try')
  tryLine.append(el('b', '', 'Try: '), document.createTextNode(scene.tryThis))
  const tags = el('ul', 'sf-scene__tags')
  for (const t of scene.tags) tags.append(el('li', 'sf-scene__tag', t))
  a.append(head, el('p', 'sf-scene__hook', scene.hook), tryLine, tags)
  const li = document.createElement('li')
  li.append(a)
  return li
}

document.getElementById('scenes')!.append(...SCENES.map(card))
