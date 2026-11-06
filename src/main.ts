import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { captureError, initAnalytics, vueErrorInfo } from './lib/analytics'
import './style.css'

const analyticsEnabled = initAnalytics()

const app = createApp(App)
const pinia = createPinia()

// Only with analytics on: otherwise Vue keeps its own error output (component trace in development).
if (analyticsEnabled) {
  app.config.errorHandler = (error, _instance, info) => {
    captureError(error, { vue_info: vueErrorInfo(info) })
    console.error(error)
  }
}

app.use(pinia)
app.use(router)

app.mount('#app')
