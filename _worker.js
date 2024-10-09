addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

addEventListener('scheduled', event => {
  event.waitUntil(handleScheduled(event.scheduledTime))
})

async function handleRequest(request) {
  return new Response('Worker is running')
}

async function handleScheduled(scheduledTime) {
  const accounts = JSON.parse(ACCOUNTS_JSON)
  const results = await loginAccounts(accounts)
  await sendSummary(results)
}

async function loginAccounts(accounts) {
  const results = []
  for (const account of accounts) {
    const result = await loginAccount(account)
    results.push({ ...account, ...result })
    await delay(Math.floor(Math.random() * 8000) + 1000)
  }
  return results
}

function generateRandomUserAgent() {
  const browsers = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera'];
  const browser = browsers[Math.floor(Math.random() * browsers.length)];
  const version = Math.floor(Math.random() * 100) + 1;
  const os = ['Windows NT 10.0', 'Macintosh', 'X11'];
  const selectedOS = os[Math.floor(Math.random() * os.length)];
  const osVersion = selectedOS === 'X11' ? 'Linux x86_64' : selectedOS === 'Macintosh' ? 'Intel Mac OS X 10_15_7' : 'Win64; x64';

  return `Mozilla/5.0 (${selectedOS}; ${osVersion}) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}/${version}.0.0.0 Safari/537.36`;
}

async function loginAccount(account) {
  const { username, password, panelnum, type } = account
  let url = type === 'ct8' 
    ? 'https://panel.ct8.pl/login/?next=/' 
    : `https://panel${panelnum}.serv00.com/login/?next=/`

  const userAgent = generateRandomUserAgent();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    })

    const pageContent = await response.text()
    const csrfMatch = pageContent.match(/name="csrfmiddlewaretoken" value="([^"]*)"/)
    const csrfToken = csrfMatch ? csrfMatch[1] : null

    if (!csrfToken) {
      throw new Error('CSRF token not found')
    }

    const initialCookies = response.headers.get('set-cookie') || ''

    const formData = new URLSearchParams({
      'username': username,
      'password': password,
      'csrfmiddlewaretoken': csrfToken,
      'next': '/'
    })

    const loginResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
        'User-Agent': userAgent,
        'Cookie': initialCookies,
      },
      body: formData.toString(),
      redirect: 'manual'
    })

    console.log(`Login response status: ${loginResponse.status}`)
    console.log(`Login response headers: ${JSON.stringify(Object.fromEntries(loginResponse.headers))}`)

    const loginResponseBody = await loginResponse.text()
    console.log(`Login response body: ${loginResponseBody.substring(0, 200)}...`)

    if (loginResponse.status === 302 && loginResponse.headers.get('location') === '/') {
      const loginCookies = loginResponse.headers.get('set-cookie') || ''
      const allCookies = combineCookies(initialCookies, loginCookies)

      const dashboardResponse = await fetch(url.replace('/login/', '/'), {
        headers: {
          'Cookie': allCookies,
          'User-Agent': userAgent,
        }
      })
      const dashboardContent = await dashboardResponse.text()
      console.log(`Dashboard content: ${dashboardContent.substring(0, 200)}...`)

      if (dashboardContent.includes('href="/logout/"') || dashboardContent.includes('href="/wyloguj/"')) {
        const nowUtc = formatToISO(new Date())
        const nowBeijing = formatToISO(new Date(Date.now() + 8 * 60 * 60 * 1000))
        const message = `账号 ${username} (${type}) 于北京时间 ${nowBeijing}（UTC时间 ${nowUtc}）登录成功！`
        console.log(message)
        await sendTelegramMessage(message)
        return { success: true, message }
      } else {
        const message = `账号 ${username} (${type}) 登录后未找到登出链接，可能登录失败。`
        console.error(message)
        await sendTelegramMessage(message)
        return { success: false, message }
      }
    } else if (loginResponseBody.includes('Nieprawidłowy login lub hasło')) {
      const message = `账号 ${username} (${type}) 登录失败：用户名或密码错误。`
      console.error(message)
      await sendTelegramMessage(message)
      return { success: false, message }
    } else {
      const message = `账号 ${username} (${type}) 登录失败，未知原因。请检查账号和密码是否正确。`
      console.error(message)
      await sendTelegramMessage(message)
      return { success: false, message }
    }
  } catch (error) {
    const message = `账号 ${username} (${type}) 登录时出现错误: ${error.message}`
    console.error(message)
    await sendTelegramMessage(message)
    return { success: false, message }
  }
}

function combineCookies(cookies1, cookies2) {
  const cookieMap = new Map()
  
  const parseCookies = (cookieString) => {
    cookieString.split(',').forEach(cookie => {
      const [fullCookie] = cookie.trim().split(';')
      const [name, value] = fullCookie.split('=')
      if (name && value) {
        cookieMap.set(name.trim(), value.trim())
      }
    })
  }

  parseCookies(cookies1)
  parseCookies(cookies2)

  return Array.from(cookieMap.entries()).map(([name, value]) => `${name}=${value}`).join('; ')
}

async function sendSummary(results) {
  const successfulLogins = results.filter(r => r.success)
  const failedLogins = results.filter(r => !r.success)

  let summaryMessage = '登录结果统计：\n'
  summaryMessage += `成功登录的账号：${successfulLogins.length}\n`
  summaryMessage += `登录失败的账号：${failedLogins.length}\n`

  if (failedLogins.length > 0) {
    summaryMessage += '\n登录失败的账号列表：\n'
    failedLogins.forEach(({ username, type, message }) => {
      summaryMessage += `- ${username} (${type}): ${message}\n`
    })
  }

  console.log(summaryMessage)
  await sendTelegramMessage(summaryMessage)
}

async function sendTelegramMessage(message) {
  const telegramConfig = JSON.parse(TELEGRAM_JSON)
  const { telegramBotToken, telegramBotUserId } = telegramConfig
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramBotUserId,
        text: message
      })
    })
  } catch (error) {
    console.error('Error sending Telegram message:', error)
  }
}

function formatToISO(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '').replace(/\.\d{3}Z/, '')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}