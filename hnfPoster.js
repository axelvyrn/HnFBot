import fetch from 'node-fetch'
import dotenv from 'dotenv'
import { TwitterApi } from 'twitter-api-v2'
import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

const RSS_URL = 'https://stacker.news/~HealthAndFitness/rss'
const GIST_ID = process.env.GIST_ID
const GIST_FILENAME = 'posted.txt'
const GIST_TOKEN = process.env.GIST_TOKEN

// Debug: Check if GIST_ID and GIST_TOKEN are loaded
if (!GIST_ID || !GIST_TOKEN) {
  console.error('Missing GIST_ID or GIST_TOKEN!')
  console.error('GIST_ID:', GIST_ID)
  console.error('GIST_TOKEN:', GIST_TOKEN ? '[set]' : '[not set]')
  process.exit(1)
}

async function loadPostedCache() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `token ${GIST_TOKEN}` }
  })
  if (!res.ok) throw new Error('Failed to fetch Gist')
  const data = await res.json()
  const content = data.files[GIST_FILENAME]?.content || ''
  return new Set(content.split('\n').map(l => l.trim()).filter(Boolean))
}

async function savePostedCache(postedSet) {
  const body = {
    files: {
      [GIST_FILENAME]: { content: Array.from(postedSet).join('\n') + '\n' }
    }
  }
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${GIST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error('Failed to update Gist')
}

async function getRSSItems() {
  const res = await fetch(RSS_URL)
  const xml = await res.text()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
  return items.map(m => {
    const block = m[1]
    const link = block.match(/<guid>(.*?)<\/guid>/)?.[1]?.trim()
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim()
    const author = block.match(/<atom:author>[\s\S]*?<atom:name>([\s\S]*?)<\/atom:name>[\s\S]*?<\/atom:author>/)?.[1]?.trim()
      || block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/)?.[1]?.trim()
      || 'Someone'
    return { link, title, author }
  })
}

function getRandomMessageFormat({ title, link, author }) {
  const formats = [
    // 1. Original
    () => `${author} just posted ${title} in ~HealthAndFitness. Check out now ${link}`,
    // 2. Variation 2
    () => `You should not miss ${author} posting ${title} on ~HealthAndFitness. Click NOW ${link}`,
    // 3. Variation 3
    () => `This is really an active post ${title} by ${author} on ~HealthAndFitness. Join in! ${link}`,
    // 4. Variation 4
    () => `You might have missed ${title} by ${author}. You won't miss it anymore. Check it here ${link}`
  ]
  const idx = Math.floor(Math.random() * formats.length)
  return formats[idx]()
}

async function postToTwitter({ title, link, author }) {
  if (!process.env.TWITTER_POSTER_API_KEY) return console.log('Twitter not configured')
  const client = new TwitterApi({
    appKey: process.env.TWITTER_POSTER_API_KEY,
    appSecret: process.env.TWITTER_POSTER_API_KEY_SECRET,
    accessToken: process.env.TWITTER_POSTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_POSTER_ACCESS_TOKEN_SECRET
  })
  
  const fullLink = link.endsWith('/r/realBitcoinDog') ? link : link + '/r/realBitcoinDog'
  let message = getRandomMessageFormat({ title, link: fullLink, author })
  if (message.length > 280) message = message.slice(0, 277) + '...'
  await client.v2.tweet(message)
  console.log('Tweeted:', message)
}

async function postToNostr({ title, link, author }) {
  // Always resolve nostr.py relative to this file (project root)
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const scriptPath = resolve(__dirname, 'nostr.py')
  return new Promise((resolve, reject) => {
    // Append /r/realBitcoinDog to the link
    const fullLink = link.endsWith('/r/realBitcoinDog') ? link : link + '/r/realBitcoinDog'
    // Use the same random message format for Nostr as for Twitter
    const message = getRandomMessageFormat({ title, link: fullLink, author })
    const entry = JSON.stringify({
      title,
      link: fullLink,
      author,
      message,
      tags: [],
    })
    const py = spawn('python3', [scriptPath, entry])
    py.stdout.on('data', data => process.stdout.write(data))
    py.stderr.on('data', data => process.stderr.write(data))
    py.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error('nostr.py failed'))
    })
  })
}

export async function runHnfBot() {
  const posted = await loadPostedCache()
  const items = await getRSSItems()

  for (const item of items) {
    if (!item.link || posted.has(item.link)) continue
    let tweeted = false, nostrPosted = false
    try {
      await postToTwitter({ title: item.title, link: item.link, author: item.author })
      tweeted = true
    } catch (e) {
      if (e?.data?.detail?.includes('duplicate')) {
        console.log('Duplicate tweet, skipping X:', item.link)
      } else {
        console.error('Twitter error:', e)
      }
    }
    try {
      await postToNostr({ title: item.title, link: item.link, author: item.author })
      nostrPosted = true
    } catch (e) {
      console.error('Nostr error:', e)
    }
    if (tweeted || nostrPosted) {
      posted.add(item.link)
      await savePostedCache(posted)
    }
    // Wait 1 second before next post
    await new Promise(res => setTimeout(res, 1000))
  }
  console.log('✅ Done.')
}

if (process.argv[1].includes('hnfPoster.js')) {
  runHnfBot()
}
