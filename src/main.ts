import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { captureError, initAnalytics } from './lib/analytics'
import './style.css'

initAnalytics()

const app = createApp(App)
const pinia = createPinia()

app.config.errorHandler = (error, _instance, info) => {
  captureError(error, { vue_info: info })
  console.error(error)
}

app.use(pinia)
app.use(router)

app.mount('#app')
