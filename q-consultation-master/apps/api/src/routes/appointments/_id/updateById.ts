import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Static, Type } from '@sinclair/typebox'
import without from 'lodash/without'
import QB, {
  promisifyCall,
  QBSession,
  QBUser,
  userHasTag,
  QBAppointment,
  QBRecord,
} from '@qc/quickblox'

import { QBCustomObjectId, QCAppointment } from '@/models'
import { APPOINTMENT_NOTIFICATION } from '@/constants/notificationTypes'

const updateAppointmentSchema = {
  tags: ['Appointments'],
  summary: 'Update appointment by id',
  params: Type.Object({
    id: QBCustomObjectId,
  }),
  body: Type.Partial(
    Type.Omit(QCAppointment, [
      '_id',
      'user_id',
      '_parent_id',
      'created_at',
      'updated_at',
      'client_id',
      'dialog_id',
    ]),
  ),
  response: {
    200: Type.Ref(QCAppointment),
  },
  security: [
    { apiKey: [] },
    { providerSession: [] },
    { clientSession: [] },
  ] as Security,
}

type SuccessResponse = Static<(typeof updateAppointmentSchema.response)['200']>

const updateAppointmentById: FastifyPluginAsyncTypebox = async (fastify) => {
  const handleValidate = async (
    body: Static<typeof updateAppointmentSchema.body>,
  ) => {
    const { provider_id } = body

    if (provider_id) {
      const provider = await promisifyCall(QB.users.getById, provider_id)

      if (!provider || !userHasTag(provider, 'provider')) {
        return fastify.httpErrors.badRequest(
          'body/provider_id Invalid property',
        )
      }
    }

    return undefined
  }

  const handleResponse = async (
    session: QBSession,
    payload: SuccessResponse | null,
    prevProviderId: QBUser['id'] | null,
  ) => {
    if (payload) {
      await promisifyCall(QB.chat.connect, {
        userId: session.user_id,
        password: session.token,
      })

      const recipients = without(
        [prevProviderId, payload.provider_id, payload.client_id],
        session.user_id,
      )

      recipients.forEach((userId) => {
        if (userId) {
          const dialogId = QB.chat.helpers.getUserJid(userId)
          const systemMessage = {
            extension: {
              notification_type: APPOINTMENT_NOTIFICATION,
              appointment_id: payload._id,
            },
          }

          QB.chat.sendSystemMessage(dialogId, systemMessage)
        }
      })
    }
  }

  fastify.patch(
    '',
    {
      schema: updateAppointmentSchema,
      onRequest: fastify.verify(fastify.BearerToken, fastify.SessionToken),
      preHandler: (request, reply, done) => {
        handleValidate(request.body).then(done).catch(done)
      },
      onResponse: (request, reply, done) => {
        const data: SuccessResponse | null = reply.payload
        const prevProviderId = request.state.get<QBUser['id'] | null>(
          'prevProviderId',
        )

        handleResponse(request.session!, data, prevProviderId)
        done()
      },
    },
    async (request) => {
      const { id } = request.params
      const { provider_id, conclusion, date_end } = request.body

      if (provider_id) {
        const {
          dialog_id,
          client_id,
          provider_id: prevProviderId,
        } = await promisifyCall(
          // TODO: Workaround. Replace with getting a custom object by id
          QB.data.update<QBAppointment>,
          'Appointment',
          { _id: id },
        )

        request.state.set('prevProviderId', prevProviderId)

        const appointmentAccessData = {
          access: 'open_for_users_ids',
          ids: [fastify.qbAdminId, provider_id, client_id].reduce<string[]>(
            (res, userId) => (userId ? [...res, userId.toString()] : res),
            [],
          ),
        }
        const recordAccessData = {
          access: 'open_for_users_ids',
          ids: [fastify.qbAdminId, provider_id].reduce<string[]>(
            (res, userId) => (userId ? [...res, userId.toString()] : res),
            [],
          ),
        }
        const appointmentPermissions = {
          read: appointmentAccessData,
          update: appointmentAccessData,
          delete: appointmentAccessData,
        }
        const recordPermissions = {
          read: recordAccessData,
          update: recordAccessData,
        }

        const data =
          conclusion && !date_end
            ? { ...request.body, date_end: new Date().toISOString() }
            : request.body

        const [appointmentResult] = await Promise.allSettled([
          promisifyCall(QB.data.update<QBAppointment>, 'Appointment', {
            ...data,
            permissions: appointmentPermissions,
            _id: id,
          }),
          promisifyCall(
            QB.data.updateByCriteria<QBRecord>,
            'Record',
            { appointment_id: id },
            {
              permissions: recordPermissions,
            },
          ),
          promisifyCall(QB.chat.dialog.update, dialog_id, {
            push_all: { occupants_ids: [provider_id] },
          }),
        ])

        if (appointmentResult.status === 'rejected') {
          throw appointmentResult.reason
        }

        return appointmentResult.value
      }

      const appointment = await promisifyCall(
        QB.data.update<QBAppointment>,
        'Appointment',
        { ...request.body, _id: id },
      )

      return appointment
    },
  )
}

export default updateAppointmentById
