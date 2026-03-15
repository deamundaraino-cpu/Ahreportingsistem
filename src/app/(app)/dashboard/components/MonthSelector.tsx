'use client'

import React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { startOfMonth, format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Card, CardContent } from '@/components/ui/card'

export function MonthSelector() {
    const router = useRouter()
    const searchParams = useSearchParams()

    // Default to current month
    const currentVal = searchParams.get('month') || format(new Date(), 'yyyy-MM')

    const handleMonthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVal = e.target.value
        if (newVal) {
            router.push(`/dashboard?month=${newVal}`)
        }
    }

    // Calculate formatted text
    let formattedText = ''
    try {
        const d = new Date(`${currentVal}-01T00:00:00`)
        formattedText = format(d, "MMMM 'de' yyyy", { locale: es })
        // capital letter
        formattedText = formattedText.charAt(0).toUpperCase() + formattedText.slice(1)
    } catch (err) { }

    return (
        <div className="flex items-center gap-4 bg-zinc-900 border border-zinc-800 p-2 rounded-lg mt-4 sm:mt-0 max-w-sm">
            <div className="flex flex-col flex-1 pl-2">
                <span className="text-xs text-zinc-400 font-medium">Periodo Seleccionado</span>
                <span className="text-sm font-semibold text-zinc-100">{formattedText}</span>
            </div>
            <input
                type="month"
                value={currentVal}
                onChange={handleMonthChange}
                className="bg-zinc-800 text-zinc-100 border-none rounded p-2 text-sm focus:ring-1 focus:ring-zinc-500 max-w-[150px] cursor-pointer"
            />
        </div>
    )
}
