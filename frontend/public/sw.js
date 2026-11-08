self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    return
  }
  if (data.v !== 1) return
  event.waitUntil(
    self.registration.showNotification(data.title || '', {
      body: data.body || '',
      tag: data.tag,
      data: { url: data.url || '/' },
      requireInteraction: Boolean(data.urgent),
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
