import Emitter from 'emitter-component'
import Backoff from 'backo'
import Multiplexer from 'lpio-multiplexer'
import debug from 'debug'
import uid from 'get-uid'

import request from './request'

let log = debug('lpio')

export default class Client {
  static DEFAULTS = {
    id: undefined,
    url: '/lpio',
    multiplex: undefined,
    backoff: undefined,
    data: undefined,
    ackTimeout: 1000,
    responseTimeout: 25000
  }

  constructor(options) {
    this.options = { ...Client.DEFAULTS, ...options}
    this.id = this.options.id
    this.connected = false
    this.disabled = true
    this.backoff = new Backoff(this.options.backoff)
    this.multiplexer = new Multiplexer(this.options.multiplex)
    this.multiplexer.on('drain', ::this.onDrain)
    this.out = new Emitter()
    this.in = new Emitter()
  }

  /**
   * Connect the client.
   *
   * @api public
   */
  connect() {
    if (this.connected || this.loading) return this.out
    log('connecting')
    this.disabled = false
    this.open()
    return this.out
  }

  /**
   * Disconnect the client.
   *
   * @api public
   */
  disconnect() {
    this.disabled = true
    if (this.request) this.request.close()
    this.onDisconnected()
    return this
  }

  /**
   * Schedule a message.
   *
   * @api public
   */
  send(options = {}, callback) {
    if (!options.type) options.type = 'data'

    if (options.type === 'data') {
      let err
      if (!options.data) err = new Error('Undefined property "data"')
      if (err) {
        if (callback) setTimeout(callback.bind(null, err))
        return this
      }
    }

    let message = {
      id: String(uid()),
      ...options
    }

    log('sending %s', message.type, message)
    this.multiplexer.add(message)
    if (callback) {
      // In this case we are not gonna get an ack at time, lets wait until
      // we are in a different state and then subscribe an ack.
      if (!this.connected || this.reopening) {
        this.out.once('success', () => this.subscribeAck(message, callback))
      }
      else this.subscribeAck(message, callback)
    }
    return this
  }

  /**
   * Subscribes ack for message, implements a timeout.
   *
   * @api private
   */
  subscribeAck(message, callback) {
    let timeoutId
    let onAck = () => {
      log('delivered %s', message.type, message)
      clearTimeout(timeoutId)
      callback()
    }
    this.in.once(`ack:${message.id}`, onAck)
    timeoutId = setTimeout(() => {
      log('message timeout', message)
      this.in.off(`ack:${message.id}`, onAck)
      callback(new Error('Delivery timeout.'))
    }, this.options.ackTimeout)
  }

  /**
   * Opens a request and sends messages.
   *
   * @api private
   */
  open(messages = []) {
    if (this.disabled || this.loading) {
      // Never loose messages, even if right now this situation should
      // not possible, its better to handle them always.
      this.multiplexer.add(messages)
      return
    }

    this.loading = true

    this.request = request({
      url: this.options.url,
      client: this.id,
      data: {...this.options.data, messages},
      onSuccess: ::this.onRequestSuccess,
      onError: err => {
        // Put unsent messages back to multiplexer in order to not to loose them.
        this.multiplexer.add(messages)
        this.onRequestError(err)
      },
      onClose: ::this.onRequestClose,
      timeout: this.options.responseTimeout
    })
  }

  /**
   * Reopens request using backoff.
   *
   * @api private
   */
  reopen() {
    if (this.reopening) return
    let backoff = this.backoff.duration()
    this.reopening = true
    this.multiplexer.stop()
    if (backoff >= this.backoff.max) this.onDisconnected()
    log('reopen in %sms', backoff)
    setTimeout(() => {
      this.reopening = false
      log('reopening')
      this.open()
    }, backoff)
  }

  /**
   * Emit to the output channel with error handling.
   * We don't want any errors in our code have effect on the reconnection logic.
   * Events are sync and errors are not catched when emitter calls listeners.
   *
   * @api private
   */
  emit() {
    try {
      this.out.emit.apply(this.out, arguments)
    }
    catch (err) {
      this.out.emit('error', err)
    }
  }

  /**
   * Set connected to false and emit disconnected if we are disconnected.
   *
   * @api private
   */
  onDisconnected() {
    if (!this.connected) return
    this.multiplexer.stop()
    // We need to unset the id in order to receive an immediate response with new
    // client id when reconnecting.
    this.id = undefined
    this.connected = false
    log('disconnected')
    this.emit('disconnected')
  }

  /**
   * Set connected to true and emit connected if we are connected.
   *
   * @api private
   */
  onConnected() {
    if (this.connected || !this.id) return
    this.connected = true
    log('connected')
    this.emit('connected')
  }

  /**
   * Fired when request is closed.
   *
   * @api private
   */
  onRequestClose() {
    this.request = undefined
    this.loading = false
  }

  /**
   * Fired when request was successfull.
   *
   * @api private
   */
  onRequestSuccess(res) {
    this.emit('success', res)
    this.backoff.reset()

    if (res.set) {
      if (res.set.id) {
        this.id = res.set.id
        // This should happen before 'set:id' event becasuse user code needs to
        // rely on the order and handle new client id reception potentially by
        // rerequesting the whole messages history (if there is one).
        this.onConnected()
        this.emit('set:id', this.id)
      }
    }

    // Its possible that it hasn't been called above, because no client id has
    // been set.
    this.onConnected()

    // Always at the end. Emitter calls handlers in sync and without catching
    // errors so a user handler might throw and cause an exit out of this function.
    // Messages handling needs to be done here, before we reopen request in order
    // to get the acks and send them with the same request.
    res.messages.forEach(::this.onMessage)

    // Get the acks right away.
    // Also in case we have got new messages while we where busy with sending previous.
    let messages = this.multiplexer.get()
    this.multiplexer.reset()
    // It won't do anything if already started.
    this.multiplexer.start()
    this.open(messages)
  }

  /**
   * Fired when request failed.
   *
   * @api private
   */
  onRequestError(err) {
    log('request error', err)
    this.emit('error', err)
    if (err.status === 401) this.onUnauthorized()
    else this.reopen()
  }

  /**
   * Client is not authorized any more.
   *
   * @api private
   */
  onUnauthorized() {
    this.emit('unauthorized')
    this.disconnect()
  }

  /**
   * Fired on every new received message.
   *
   * @api private
   */
  onMessage(message) {
    log('received %s', message.type, message)
    this.emit('message', message)

    switch (message.type) {
      case 'ack':
        this.in.emit(`ack:${message.id}`, message)
        // No need to send an ack in response to an ack.
        return
      case 'data':
        if (message.data) this.emit('data', message.data)
        break
      default:
    }

    // Lets schedule an confirmation.
    this.multiplexer.add({
      type: 'ack',
      id: message.id
    })
  }

  /**
   * Fired when multiplexer did a clean up.
   *
   * @api private
   */
  onDrain(messages) {
    if (this.request) this.request.close()
    this.open(messages)
  }
}
