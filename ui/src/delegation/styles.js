// Registers this folder's one stylesheet once, whichever component imports it first.
import { defineStyles } from '../styles.js'
import css from './delegation.css'

defineStyles(css)
