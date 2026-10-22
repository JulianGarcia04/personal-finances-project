import type { Component } from 'vue'
import {
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield
} from 'lucide-vue-next'

const CATEGORY_ICON_COMPONENTS: Record<string, Component> = {
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield
}

export const CATEGORY_ICONS = [
  { name: 'Utensils', label: 'Comida' },
  { name: 'Car', label: 'Transporte' },
  { name: 'Film', label: 'Entretenimiento' },
  { name: 'Lightbulb', label: 'Servicios' },
  { name: 'Heart', label: 'Salud' },
  { name: 'GraduationCap', label: 'Educación' },
  { name: 'TrendingUp', label: 'Ingresos' },
  { name: 'HelpCircle', label: 'Otros' },
  { name: 'ShoppingBag', label: 'Compras' },
  { name: 'Home', label: 'Hogar' },
  { name: 'Gift', label: 'Regalos' },
  { name: 'Coffee', label: 'Café/Snacks' },
  { name: 'Plane', label: 'Viajes' },
  { name: 'DollarSign', label: 'Finanzas' },
  { name: 'PiggyBank', label: 'Ahorro' },
  { name: 'Smartphone', label: 'Tecnología' },
  { name: 'Activity', label: 'Deporte' },
  { name: 'Scissors', label: 'Cuidado' },
  { name: 'BookOpen', label: 'Libros' },
  { name: 'Wrench', label: 'Soporte' },
  { name: 'Shield', label: 'Seguros' }
]

export const CATEGORY_COLORS = [
  '#10b981', // Emerald
  '#f43f5e', // Rose
  '#3b82f6', // Blue
  '#fbbf24', // Amber
  '#ec4899', // Pink
  '#8b5cf6', // Violet
  '#14b8a6', // Teal
  '#6366f1', // Indigo
  '#6b7280', // Gray
]

export const getCategoryIconComponent = (iconName: string): Component =>
  CATEGORY_ICON_COMPONENTS[iconName] ?? HelpCircle
